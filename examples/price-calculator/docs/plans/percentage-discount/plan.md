# Percentage Discount

## Context

The example currently totals line items using integer cents. It needs one bounded quantitative change that is easy to inspect but still exercises planning, implementation, deterministic Checks, and independent Reviews.

## Goal

Add an optional percentage discount to `calculateTotal` while preserving the existing one-argument behavior and integer-cents result.

## Non-goals

Do not add taxes, currencies, coupons, tiered pricing, persistence, dependencies, or a general pricing framework.

## Current structure

`src/price.mjs` contains one deterministic `calculateTotal(lines)` function. `test/price.mjs` covers subtotal behavior and invalid monetary inputs.

## Proposed direction

Accept an optional second argument with `discountPercent`. Validate it as a safe integer from zero through one hundred, calculate the discount once against the complete subtotal, and round the discounted result to the nearest cent with half cents rounded up.

## Architecture

Keep validation and arithmetic inside the existing module. Preserve the function as a deterministic domain operation and avoid new factories, classes, services, or configuration layers.

## Quantitative implications

Prices remain integer cents and quantities remain non-negative integers. The percentage is an integer in `[0, 100]`. Applying the discount once to the subtotal avoids line-level rounding differences. Half-cent results round upward, and intermediate arithmetic must remain within JavaScript's safe integer range.

## Risks

Incorrect rounding order could produce a one-cent discrepancy. Multiplication by the percentage factor could exceed the safe integer range even when the original subtotal is valid.

## Open questions

None. The example Plan deliberately fixes its rounding and validation choices.
