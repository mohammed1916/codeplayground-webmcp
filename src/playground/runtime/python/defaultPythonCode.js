export const DEFAULT_PYTHON_CODE = `from typing import List

class Solution:
    def maxProfit(self, prices: List[int]) -> int:
        minPrice = float("inf")
        maxProfit = 0
        for price in prices:
            if price < minPrice:
                minPrice = price
            elif price - minPrice > maxProfit:
                maxProfit = price - minPrice
        return maxProfit
`

export const DEFAULT_PYTHON_INPUT = Object.freeze({
  prices: Object.freeze([7, 1, 5, 3, 6, 4]),
})
