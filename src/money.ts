/**
 * Exact decimal arithmetic for money actions. salt-api validates an
 * invoice's line items with `subtotal == qty * unit_price` EXACTLY
 * (CLAUDE.md: "line_items jsonb (model-validated: subtotal = qty x
 * unit_price exactly...)"), so a float multiply that drifts by even one
 * cent on an unlucky value gets the whole invoice rejected. BigInt-scaled
 * multiplication never drifts.
 */

export function multiplyDecimalByInt(decimal: string, qty: number): string {
  const negative = decimal.trim().startsWith("-");
  const unsigned = negative ? decimal.trim().slice(1) : decimal.trim();
  const [whole, frac = ""] = unsigned.split(".");
  const digits = `${whole || "0"}${frac}`;
  const scaled = BigInt(digits === "" ? "0" : digits);
  const product = scaled * BigInt(qty);
  const productStr = product.toString().padStart(frac.length + 1, "0");
  const cut = productStr.length - frac.length;
  const resultWhole = productStr.slice(0, cut) || "0";
  const resultFrac = productStr.slice(cut);
  const result = resultFrac.length > 0 ? `${resultWhole}.${resultFrac}` : resultWhole;
  return negative && product !== 0n ? `-${result}` : result;
}
