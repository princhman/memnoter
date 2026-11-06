// A deliberately small native outline label, not a TeX typesetter. Unknown
// commands preserve the original source rather than silently losing meaning.
const symbols: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ",
  lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Sigma: "Σ", Omega: "Ω",
  times: "×", cdot: "\u00b7", pm: "±", leq: "≤", geq: "≥", neq: "≠", approx: "≈",
  infty: "∞", sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", to: "→",
};
export function headingMathLabel(source: string): string {
  const raw = source.replace(/\u200b/g, "");
  let value = raw.replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
    .replace(/\\([a-zA-Z]+)/g, (command, name: string) => symbols[name] ?? command);
  if (/\\[a-zA-Z]+/.test(value)) return raw;
  const scripts = (chars: string, mapped: string) => (match: string, group: string, single: string) => {
    const text = group ?? single;
    return [...text].every(c => chars.includes(c)) ? [...text].map(c => mapped[chars.indexOf(c)]).join("") : match;
  };
  value = value.replace(/\^(?:\{([^{}]*)\}|([a-zA-Z0-9+−=-]))/g, scripts("0123456789+-=ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼ⁿⁱ"))
    .replace(/_(?:\{([^{}]*)\}|([a-zA-Z0-9+−=-]))/g, scripts("0123456789+-=aehijklmnoprstuvx", "₀₁₂₃₄₅₆₇₈₉₊₋₌ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"));
  return value;
}
