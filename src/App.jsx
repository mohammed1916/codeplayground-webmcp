import RuntimePlayground from "./playground/RuntimePlayground";
import { ThemeProvider } from "./context/ThemeContext";
import "./App.css";

export default function App() {
  return (
    <ThemeProvider>
      <div className="app-shell">
        <RuntimePlayground layoutWidth="full" />
      </div>
    </ThemeProvider>
  );
}
