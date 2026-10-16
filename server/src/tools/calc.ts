/** Safe arithmetic evaluator (shunting-yard): + - * / % ^ parentheses, unary minus, a few functions. No eval(). */
const FUNCS: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, ln: Math.log, log: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan };
const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3, "u-": 4 };

export function calculate(expr: string): number {
  const tokens = expr.replace(/\s+/g, "").match(/\d+(?:\.\d+)?|[a-z]+|[-+*/%^()]/gi);
  if (!tokens || tokens.join("") !== expr.replace(/\s+/g, "")) throw new Error("invalid expression");
  const out: number[] = [];
  const ops: string[] = [];
  const apply = (op: string) => {
    if (op === "u-") { out.push(-(out.pop() ?? NaN)); return; }
    if (op in FUNCS) { out.push(FUNCS[op]!(out.pop() ?? NaN)); return; }
    const b = out.pop(), a = out.pop();
    if (a === undefined || b === undefined) throw new Error("invalid expression");
    out.push(op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : op === "%" ? a % b : a ** b);
  };
  let prevVal = false;
  for (const t of tokens) {
    if (/^\d/.test(t)) { out.push(Number(t)); prevVal = true; }
    else if (/^[a-z]+$/i.test(t)) { if (!(t in FUNCS)) throw new Error(`unknown function ${t}`); ops.push(t); prevVal = false; }
    else if (t === "(") { ops.push(t); prevVal = false; }
    else if (t === ")") { while (ops.length && ops[ops.length - 1] !== "(") apply(ops.pop()!); if (ops.pop() !== "(") throw new Error("mismatched parentheses"); if (ops.length && ops[ops.length - 1]! in FUNCS) apply(ops.pop()!); prevVal = true; }
    else {
      const op = t === "-" && !prevVal ? "u-" : t;
      while (ops.length) {
        const top = ops[ops.length - 1]!;
        if (top === "(" || top in FUNCS) break;
        const higher = PREC[top]! > PREC[op]! || (PREC[top] === PREC[op] && op !== "^" && op !== "u-");
        if (!higher) break;
        apply(ops.pop()!);
      }
      ops.push(op); prevVal = false;
    }
  }
  while (ops.length) { const op = ops.pop()!; if (op === "(") throw new Error("mismatched parentheses"); apply(op); }
  if (out.length !== 1 || !Number.isFinite(out[0]!)) throw new Error("invalid expression");
  return out[0]!;
}
