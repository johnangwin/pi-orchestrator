function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function calculateTotal(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError("lines must be an array");
  }

  return lines.reduce((total, line, index) => {
    if (line === null || typeof line !== "object") {
      throw new TypeError(`lines[${index}] must be an object`);
    }
    requireNonNegativeInteger(
      line.unitPriceCents,
      `lines[${index}].unitPriceCents`,
    );
    requireNonNegativeInteger(line.quantity, `lines[${index}].quantity`);
    const lineTotal = line.unitPriceCents * line.quantity;
    if (
      !Number.isSafeInteger(lineTotal) ||
      !Number.isSafeInteger(total + lineTotal)
    ) {
      throw new RangeError("total exceeds the safe integer range");
    }
    return total + lineTotal;
  }, 0);
}
