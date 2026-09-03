// Kept as a source string so the same tracing program runs inside Pyodide's
// CPython runtime. It returns JSON rather than PyProxy objects, which keeps the
// worker boundary deterministic and avoids proxy lifetime leaks.
export const PYTHON_TRACER_SOURCE = String.raw`
import ast
import inspect
import json
import math
import re
import sys
import traceback
import types
from collections import Counter, defaultdict, deque

_USER_FILENAME = "<user_code>"
_MAX_FRAMES = max(1, min(1000, int(__trace_max_frames)))
_MAX_LOCALS = 32
_MAX_ITEMS = 200
_MAX_DEPTH = 5
_MAX_STRING = 1000
_source = __trace_source
_input = json.loads(__trace_input_json)
_entry_request = json.loads(__trace_entry_json)


def _short_text(value, limit=_MAX_STRING):
    text = str(value)
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _base36(value):
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    output = ""
    while value:
        value, remainder = divmod(value, 36)
        output = alphabet[remainder] + output
    return output


def _stable_variable_id(name):
    text = str(name)
    lowered = text.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")[:40] or "value"
    value = 2166136261
    encoded = text.encode("utf-16-le", errors="surrogatepass")
    for index in range(0, len(encoded), 2):
        code_unit = encoded[index] | (encoded[index + 1] << 8)
        value ^= code_unit
        value = (value * 16777619) & 0xFFFFFFFF
    return "python-" + slug + "-" + _base36(value)[:7]


def _runtime_type(value):
    if value is None:
        return "none"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, deque):
        return "deque"
    if isinstance(value, Counter):
        return "counter"
    if isinstance(value, defaultdict):
        return "defaultdict"
    if isinstance(value, list):
        return "list"
    if isinstance(value, tuple):
        return "tuple"
    if isinstance(value, (set, frozenset)):
        return "set"
    if isinstance(value, dict):
        return "dict"
    return type(value).__name__


def _safe(value, depth=0, seen=None):
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, str):
        return _short_text(value)
    if isinstance(value, bytes):
        return _short_text(value.decode("utf-8", errors="replace"))
    if isinstance(value, (types.ModuleType, types.FunctionType, types.MethodType, type)):
        return None
    if depth >= _MAX_DEPTH:
        return "[Max depth]"

    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return "[Circular]"
    seen.add(identity)

    try:
        if isinstance(value, (list, tuple, deque)):
            return [_safe(item, depth + 1, seen) for item in list(value)[:_MAX_ITEMS]]
        if isinstance(value, (set, frozenset)):
            ordered = sorted(value, key=lambda item: repr(item))[:_MAX_ITEMS]
            return [_safe(item, depth + 1, seen) for item in ordered]
        if isinstance(value, dict):
            output = {}
            for key, item in list(value.items())[:_MAX_ITEMS]:
                safe_key = key if isinstance(key, str) else _short_text(repr(key), 160)
                output[_short_text(safe_key, 160)] = _safe(item, depth + 1, seen)
            return output
        if hasattr(value, "__dict__"):
            output = {"__class__": type(value).__name__}
            for key, item in list(vars(value).items())[:_MAX_ITEMS]:
                if str(key).startswith("_"):
                    continue
                output[_short_text(key, 160)] = _safe(item, depth + 1, seen)
            return output
        return _short_text(repr(value))
    except Exception:
        try:
            return _short_text(repr(value))
        except Exception:
            return "[Unavailable]"
    finally:
        seen.discard(identity)


def _suggested_kind(name, runtime_type, value):
    if "listnode" in str(runtime_type).lower():
        return "graph"
    if runtime_type == "list":
        if value and all(
            item is None or (
                isinstance(item, dict)
                and "listnode" in str(item.get("__class__", "")).lower()
                and "next" in item
            )
            for item in value
        ):
            return "graph"
        is_grid = bool(value) and all(isinstance(row, (list, tuple)) for row in value)
        if is_grid:
            return "grid"
        return "sequence"
    if runtime_type in ("tuple", "deque", "str"):
        return "sequence"
    if runtime_type in ("dict", "defaultdict", "counter", "set"):
        return "associative"
    return "scalar"


def _target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for item in target.elts:
            names.extend(_target_names(item))
        return names
    return []


def _expression_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _expression_name(node.value)
        return (parent + "." if parent else "") + node.attr
    return None


def _range_target_hint(node):
    if not isinstance(node, ast.Call):
        return None
    if not isinstance(node.func, ast.Name) or node.func.id != "range":
        return None
    for argument in node.args:
        if (
            isinstance(argument, ast.Call)
            and isinstance(argument.func, ast.Name)
            and argument.func.id == "len"
            and argument.args
        ):
            return _expression_name(argument.args[0])
    return None


class _LoopCollector(ast.NodeVisitor):
    def __init__(self):
        self.bindings = []
        self._seen = set()

    def _add(self, name, role, target=None, line=None, index_offset=None):
        if not name or name in self._seen:
            return
        self._seen.add(name)
        self.bindings.append({
            "name": name,
            "role": role,
            "target": target,
            "line": line,
            "indexOffset": index_offset,
        })

    def visit_For(self, node):
        names = _target_names(node.target)
        iterator_name = _expression_name(node.iter)
        if isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Name):
            if node.iter.func.id == "enumerate" and names:
                target = _expression_name(node.iter.args[0]) if node.iter.args else None
                start_node = node.iter.args[1] if len(node.iter.args) > 1 else None
                if start_node is None:
                    start_node = next(
                        (keyword.value for keyword in node.iter.keywords if keyword.arg == "start"),
                        None,
                    )
                index_offset = (
                    start_node.value
                    if isinstance(start_node, ast.Constant)
                    and isinstance(start_node.value, int)
                    and not isinstance(start_node.value, bool)
                    else 0
                )
                self._add(names[0], "index", target, node.lineno, index_offset)
                for name in names[1:]:
                    self._add(name, "value", target, node.lineno)
            elif node.iter.func.id == "range":
                target = _range_target_hint(node.iter)
                for name in names:
                    self._add(name, "index", target, node.lineno)
            else:
                for name in names:
                    self._add(name, "value", iterator_name, node.lineno)
        else:
            for name in names:
                self._add(name, "value", iterator_name, node.lineno)
        self.generic_visit(node)

    def visit_comprehension(self, node):
        names = _target_names(node.target)
        target = _expression_name(node.iter)
        for name in names:
            self._add(name, "value", target, getattr(node, "lineno", None))
        self.generic_visit(node)

    def visit_Subscript(self, node):
        target = _expression_name(node.value)
        index_node = node.slice
        if isinstance(index_node, ast.Name):
            self._add(index_node.id, "index", target, getattr(node, "lineno", None))
        self.generic_visit(node)


def _public_definitions(tree):
    solution = None
    functions = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Solution":
            solution = node
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            functions.append(node.name)
    return solution, functions


def _resolve_entry(namespace, tree, requested):
    solution_node, module_functions = _public_definitions(tree)

    if requested:
        path = str(requested).strip()
        parts = [part for part in path.split(".") if part]
        if len(parts) == 2:
            owner_name, member_name = parts
            owner = namespace.get(owner_name)
            if not isinstance(owner, type):
                raise ValueError("Entry class '" + owner_name + "' was not found.")
            instance = owner()
            candidate = getattr(instance, member_name, None)
            if not callable(candidate):
                raise ValueError("Entry method '" + path + "' was not found.")
            return candidate, {
                "kind": "class-method",
                "className": owner_name,
                "functionName": member_name,
                "displayName": path,
            }
        if len(parts) == 1:
            name = parts[0]
            candidate = namespace.get(name)
            if callable(candidate) and not isinstance(candidate, type):
                return candidate, {
                    "kind": "function",
                    "className": None,
                    "functionName": name,
                    "displayName": name,
                }
            solution_class = namespace.get("Solution")
            if isinstance(solution_class, type):
                instance = solution_class()
                candidate = getattr(instance, name, None)
                if callable(candidate):
                    return candidate, {
                        "kind": "class-method",
                        "className": "Solution",
                        "functionName": name,
                        "displayName": "Solution." + name,
                    }
        raise ValueError("Entry '" + path + "' was not found.")

    if solution_node is not None:
        methods = [
            node.name
            for node in solution_node.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and not node.name.startswith("_")
        ]
        if len(methods) != 1:
            raise ValueError(
                "class Solution must contain exactly one public method; found "
                + str(len(methods))
                + ". Pass an explicit entry to choose one."
            )
        solution_class = namespace.get("Solution")
        instance = solution_class()
        method_name = methods[0]
        return getattr(instance, method_name), {
            "kind": "class-method",
            "className": "Solution",
            "functionName": method_name,
            "displayName": "Solution." + method_name,
        }

    if len(module_functions) != 1:
        raise ValueError(
            "Python source must define class Solution with one public method or exactly one public function."
        )
    function_name = module_functions[0]
    return namespace[function_name], {
        "kind": "function",
        "className": None,
        "functionName": function_name,
        "displayName": function_name,
    }


class _DefaultListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next


class _DefaultTreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right


def _prepare_arguments(callable_entry, value):
    signature = inspect.signature(callable_entry)
    parameters = [
        parameter
        for parameter in signature.parameters.values()
        if parameter.kind not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
    ]

    is_reserved_envelope = (
        isinstance(value, dict)
        and bool(set(value) & {"__viz_args__", "__viz_kwargs__"})
        and set(value).issubset({"__viz_args__", "__viz_kwargs__"})
    )
    if is_reserved_envelope:
        args = value.get("__viz_args__", [])
        kwargs = value.get("__viz_kwargs__", {})
        if not isinstance(args, list) or not isinstance(kwargs, dict):
            raise ValueError(
                "Input envelope requires an array '__viz_args__' and object '__viz_kwargs__'."
            )
        return args, kwargs

    def linked_list(items):
        dummy = _DefaultListNode(0)
        tail = dummy
        for item in items:
            tail.next = _DefaultListNode(item)
            tail = tail.next
        return dummy.next

    def coerce(parameter, item):
        name = parameter.name.lower()
        annotation = str(parameter.annotation).lower()
        expects_nodes = "listnode" in annotation or "node" in name or name in ("lists", "heads")
        if not expects_nodes:
            return item
        if name in ("lists", "heads") and isinstance(item, list):
            return [
                linked_list(sequence) if isinstance(sequence, list) else sequence
                for sequence in item
            ]
        if isinstance(item, list):
            return linked_list(item)
        return item

    if isinstance(value, dict):
        by_name = {parameter.name: parameter for parameter in parameters}
        return [], {
            name: coerce(by_name[name], item) if name in by_name else item
            for name, item in value.items()
        }

    if isinstance(value, list):
        if len(parameters) == 1:
            return [value], {}
        return value, {}

    if value is None:
        if len(parameters) == 1:
            return [value], {}
        return [], {}
    if len(parameters) == 1:
        return [value], {}
    raise ValueError("Non-array input can only be passed to a single-argument entry.")


def _build_namespace():
    namespace = {
        "__name__": "__main__",
        "ListNode": _DefaultListNode,
        "TreeNode": _DefaultTreeNode,
    }
    conveniences = """
from typing import List, Optional, Dict, Set, Tuple, Deque, DefaultDict, Iterable, Iterator
from collections import Counter, defaultdict, deque
from heapq import heapify, heappop, heappush, heapreplace, nlargest, nsmallest
from bisect import bisect_left, bisect_right, insort
from math import inf
"""
    exec(conveniences, namespace, namespace)
    return namespace


def _run_trace():
    tree = ast.parse(_source, filename=_USER_FILENAME, mode="exec")
    collector = _LoopCollector()
    collector.visit(tree)
    loop_bindings = collector.bindings
    loop_by_name = {}
    for binding in loop_bindings:
        loop_by_name.setdefault(binding["name"], binding)

    namespace = _build_namespace()
    code = compile(tree, _USER_FILENAME, "exec")
    exec(code, namespace, namespace)
    callable_entry, entry = _resolve_entry(namespace, tree, _entry_request)
    args, kwargs = _prepare_arguments(callable_entry, _input)

    try:
        inspect.signature(callable_entry).bind(*args, **kwargs)
    except TypeError as error:
        raise ValueError(
            "Input JSON does not match entry " + entry["displayName"] + ": "
            + str(error) + ". Update Method arguments in the Inputs tab."
        ) from error

    trace_frames = []
    catalog = {}
    previous_by_frame = {}
    previous_line_by_frame = {}
    scope_by_frame = {}
    loop_positions_by_frame = {}
    next_scope_number = 0
    entry_scope_id = None
    truncated = False
    overflow_frame = None
    omitted_events = 0
    trace_events = 0

    def safe_locals(frame):
        values = {}
        runtime_types = {}
        for name, value in list(frame.f_locals.items()):
            if len(values) >= _MAX_LOCALS:
                break
            if name == "self" or name.startswith("__"):
                continue
            if isinstance(value, (types.ModuleType, types.FunctionType, types.MethodType, type)):
                continue
            safe_value = _safe(value)
            if safe_value is None and value is not None:
                continue
            values[name] = safe_value
            runtime_types[name] = _runtime_type(value)
        return values, runtime_types

    def update_catalog(values, runtime_types, scope, frame_index):
        for name, value in values.items():
            runtime_type = runtime_types.get(name, "unknown")
            current = catalog.get(name)
            suggested_kind = _suggested_kind(name, runtime_type, value)
            if current is None:
                loop = loop_by_name.get(name)
                current = {
                    "id": _stable_variable_id(name),
                    "name": name,
                    "label": "return" if name == "$return" else name,
                    "types": [],
                    "suggestedKind": suggested_kind,
                    "suggestedKinds": [],
                    "firstFrame": frame_index,
                    "lastFrame": frame_index,
                    "scopes": [],
                    "isLoopBinding": loop is not None,
                    "loopRole": loop.get("role") if loop else None,
                    "targetHint": loop.get("target") if loop else None,
                    "indexOffset": loop.get("indexOffset") if loop else None,
                }
                catalog[name] = current
            current["suggestedKind"] = suggested_kind
            if suggested_kind not in current["suggestedKinds"]:
                current["suggestedKinds"].append(suggested_kind)
            if runtime_type not in current["types"]:
                current["types"].append(runtime_type)
            if scope not in current["scopes"]:
                current["scopes"].append(scope)
            current["lastFrame"] = frame_index

    def frame_target_value(frame, target):
        if not target:
            return None
        parts = str(target).split(".")
        if not parts:
            return None
        if parts[0] in frame.f_locals:
            value = frame.f_locals[parts[0]]
        elif parts[0] in frame.f_globals:
            value = frame.f_globals[parts[0]]
        else:
            return None
        try:
            for part in parts[1:]:
                value = getattr(value, part)
            return value
        except Exception:
            return None

    def values_equal(first, second):
        try:
            result = first == second
            return result if isinstance(result, bool) else False
        except Exception:
            return False

    def loop_binding_details(frame, values, source_line):
        frame_key = id(frame)
        position_state = loop_positions_by_frame.setdefault(frame_key, {})
        details = {}
        for binding in loop_bindings:
            name = binding["name"]
            if name not in values or name not in frame.f_locals:
                continue
            role = binding.get("role")
            target_name = binding.get("target")
            detail = {
                "name": name,
                "role": role,
                "target": target_name,
                "index": None,
                "ambiguous": False,
                "indexOffset": binding.get("indexOffset"),
            }
            raw_value = frame.f_locals[name]

            if role == "index":
                offset = binding.get("indexOffset") or 0
                if isinstance(raw_value, int) and not isinstance(raw_value, bool):
                    detail["index"] = raw_value - offset
                details[name] = detail
                continue

            target_value = frame_target_value(frame, target_name)
            if isinstance(target_value, (list, tuple, deque, str)):
                sequence = list(target_value)
                matches = [
                    index
                    for index, item in enumerate(sequence)
                    if values_equal(item, raw_value)
                ]
                state_key = name + "@" + str(binding.get("line"))
                previous_index = position_state.get(state_key)
                is_iteration_boundary = (
                    binding.get("line") is not None
                    and source_line == binding.get("line")
                )
                index = None

                if is_iteration_boundary:
                    candidate = 0 if previous_index is None else previous_index + 1
                    if candidate < len(sequence) and values_equal(sequence[candidate], raw_value):
                        index = candidate
                    else:
                        later_matches = [
                            match
                            for match in matches
                            if previous_index is None or match > previous_index
                        ]
                        if len(later_matches) == 1:
                            index = later_matches[0]
                elif (
                    previous_index is not None
                    and previous_index < len(sequence)
                    and values_equal(sequence[previous_index], raw_value)
                ):
                    index = previous_index
                elif len(matches) == 1:
                    index = matches[0]

                if index is not None:
                    position_state[state_key] = index
                    detail["index"] = index
                else:
                    detail["ambiguous"] = len(matches) > 1
            details[name] = detail
        return details

    def make_trace_frame(frame, event, line, executed_line, return_value, values, runtime_types):
        frame_key = id(frame)
        scope_info = scope_by_frame.get(frame_key, {})
        if event == "return" and scope_info.get("id") == entry_scope_id:
            values = dict(values)
            runtime_types = dict(runtime_types)
            values["$return"] = _safe(return_value)
            runtime_types["$return"] = _runtime_type(return_value)
        source_line = executed_line if executed_line is not None else line
        previous = previous_by_frame.get(frame_key)
        previous_values = previous["values"] if previous else {}
        missing = object()
        changed = [
            name for name in set(previous_values) | set(values)
            if previous_values.get(name, missing) != values.get(name, missing)
        ]
        fingerprint = json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        previous_by_frame[frame_key] = {
            "fingerprint": fingerprint,
            "values": values,
            "sourceLine": source_line,
        }

        scope = getattr(frame.f_code, "co_qualname", frame.f_code.co_name)
        frame_index = min(len(trace_frames), _MAX_FRAMES - 1)
        update_catalog(values, runtime_types, scope, frame_index)
        loop_details = loop_binding_details(frame, values, source_line)
        trace_frame = {
            "id": frame_index,
            "event": event,
            "line": source_line,
            "nextLine": line if event == "line" else None,
            "function": frame.f_code.co_name,
            "scope": scope,
            "scopeId": scope_info.get("id", scope),
            "parentScopeId": scope_info.get("parentId"),
            "isEntryScope": scope_info.get("id") == entry_scope_id,
            "depth": scope_info.get("depth", 0),
            "message": (
                "Return from " + frame.f_code.co_name
                if event == "return"
                else "Line " + str(source_line) + " in " + frame.f_code.co_name
            ),
            "locals": values,
            "localTypes": runtime_types,
            "changed": sorted(changed),
            "loopBindings": {
                name: detail_value
                for name, detail_value in values.items()
                if name in loop_details
            },
            "loopBindingDetails": loop_details,
        }
        if event == "return":
            trace_frame["returnValue"] = _safe(return_value)
        return trace_frame

    def record(frame, event, line, executed_line=None, return_value=None):
        nonlocal truncated, overflow_frame, omitted_events, trace_events
        trace_events += 1
        if len(trace_frames) >= _MAX_FRAMES:
            truncated = True
            omitted_events += 1
            if event not in ("return", "exception"):
                return

        values, runtime_types = safe_locals(frame)
        frame_key = id(frame)
        fingerprint = json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        previous = previous_by_frame.get(frame_key)
        source_line = executed_line if executed_line is not None else line
        if (
            event == "line"
            and previous is not None
            and previous["fingerprint"] == fingerprint
            and previous.get("sourceLine") == source_line
        ):
            return
        trace_frame = make_trace_frame(
            frame,
            event,
            line,
            executed_line,
            return_value,
            values,
            runtime_types,
        )
        if len(trace_frames) < _MAX_FRAMES:
            trace_frame["id"] = len(trace_frames)
            trace_frames.append(trace_frame)
        else:
            overflow_frame = trace_frame

    def tracer(frame, event, arg):
        nonlocal next_scope_number, entry_scope_id
        if frame.f_code.co_filename != _USER_FILENAME:
            return None

        frame_key = id(frame)
        if event == "call":
            next_scope_number += 1
            parent_info = scope_by_frame.get(id(frame.f_back)) if frame.f_back is not None else None
            scope_id = "scope-" + str(next_scope_number)
            if entry_scope_id is None:
                entry_scope_id = scope_id
            scope_by_frame[frame_key] = {
                "id": scope_id,
                "parentId": parent_info.get("id") if parent_info else None,
                "depth": (parent_info.get("depth", -1) + 1) if parent_info else 0,
            }
            previous_line_by_frame[frame_key] = frame.f_lineno
            record(frame, "call", frame.f_lineno)
        elif event == "line":
            previous_line = previous_line_by_frame.get(frame_key)
            record(frame, "line", frame.f_lineno, previous_line)
            previous_line_by_frame[frame_key] = frame.f_lineno
        elif event == "exception":
            record(frame, "exception", frame.f_lineno, frame.f_lineno)
        elif event == "return":
            previous_line = previous_line_by_frame.get(frame_key)
            record(frame, "return", frame.f_lineno, previous_line, arg)
            previous_by_frame.pop(frame_key, None)
            previous_line_by_frame.pop(frame_key, None)
            scope_by_frame.pop(frame_key, None)
            loop_positions_by_frame.pop(frame_key, None)
        return tracer

    sys.settrace(tracer)
    try:
        result = callable_entry(*args, **kwargs)
        if inspect.isawaitable(result):
            raise TypeError("Async Python entries are not supported by the trace runner yet.")
    finally:
        sys.settrace(None)

    if truncated and overflow_frame is not None:
        overflow_frame["id"] = max(0, len(trace_frames) - 1)
        if trace_frames:
            trace_frames[-1] = overflow_frame
        else:
            trace_frames.append(overflow_frame)

    variables = sorted(catalog.values(), key=lambda item: (item["firstFrame"], item["name"]))
    final_state_preserved = bool(
        not truncated
        or (
            overflow_frame is not None
            and overflow_frame.get("event") == "return"
            and overflow_frame.get("isEntryScope")
        )
    )
    return {
        "traceFrames": trace_frames,
        "variables": variables,
        "result": _safe(result),
        "entry": entry,
        "loopBindings": loop_bindings,
        "truncated": truncated,
        "truncation": {
            "truncated": truncated,
            "maxFrames": _MAX_FRAMES,
            "recordedFrames": len(trace_frames),
            "omittedEvents": omitted_events,
            "totalTraceEvents": trace_events,
            "finalStatePreserved": final_state_preserved,
            "message": (
                "Trace was limited to " + str(_MAX_FRAMES) + " frames; the final state is preserved."
                if truncated and final_state_preserved
                else (
                    "Trace was limited to " + str(_MAX_FRAMES) + " frames before a final state was available."
                    if truncated
                    else None
                )
            ),
        },
    }


def _error_location(error):
    line = getattr(error, "lineno", None)
    column = getattr(error, "offset", None)
    traceback_cursor = error.__traceback__
    while traceback_cursor is not None:
        if traceback_cursor.tb_frame.f_code.co_filename == _USER_FILENAME:
            line = traceback_cursor.tb_lineno
        traceback_cursor = traceback_cursor.tb_next
    return line, column


try:
    _trace_output = _run_trace()
except SyntaxError as error:
    _trace_output = {
        "error": {
            "name": "SyntaxError",
            "code": "PYTHON_SYNTAX_ERROR",
            "message": str(error),
            "line": error.lineno,
            "column": error.offset,
            "stack": "".join(traceback.format_exception(type(error), error, error.__traceback__))[-8000:],
        }
    }
except Exception as error:
    _error_line, _error_column = _error_location(error)
    _trace_output = {
        "error": {
            "name": type(error).__name__,
            "code": "PYTHON_RUNTIME_ERROR",
            "message": str(error),
            "line": _error_line,
            "column": _error_column,
            "stack": "".join(traceback.format_exception(type(error), error, error.__traceback__))[-8000:],
        }
    }
finally:
    sys.settrace(None)

__trace_result_json = json.dumps(_trace_output, ensure_ascii=False, separators=(",", ":"))
__trace_result_json
`
