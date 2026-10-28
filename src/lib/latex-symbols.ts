/**
 * LaTeX commands offered by the  \  autocomplete, with search.
 *
 * Each spec is `[insert, keywords?, preview?]`:
 *   - insert:  the source to insert. `§` marks where the caret lands; without
 *              it the caret goes into the first empty `{}` or `[]`, else to the end.
 *   - keywords: words to find the command by when its name is forgotten.
 *   - preview: what KaTeX renders as the icon, when `insert` alone shows nothing useful.
 */

export type LatexEntry = {
  /** The command word typed after  \  (`frac` for `\frac{}{}`). */
  name: string;
  /** Short source shown in the menu. */
  label: string;
  insert: string;
  caret: number;
  preview: string;
  keywords: string[];
  category: string;
  /** What sets it apart from the commands in `similar`. */
  note?: string;
  similar?: LatexEntry[];
};

type Spec = [insert: string, keywords?: string, preview?: string];

const CARET = "§";

function firstSlot(text: string) {
  const slots = [text.indexOf("{}"), text.indexOf("[]")].filter((index) => index >= 0);
  return slots.length ? Math.min(...slots) + 1 : -1;
}

function samplePreview(insert: string) {
  const samples = ["a", "b", "c"];
  let next = 0;
  return insert
    .replace("[]", "[n]")
    .replace(/\{\}/g, () => `{${samples[next++] ?? "x"}}`);
}

function group(category: string, specs: Spec[]): LatexEntry[] {
  return specs.map(([source, keywords = "", preview]) => {
    const marker = source.indexOf(CARET);
    const insert = source.replace(CARET, "");
    const slot = firstSlot(insert);
    const env = /^\\begin\{(\w+\*?)\}/.exec(insert)?.[1];
    const words = keywords.split(/\s+/).filter(Boolean);
    if (env) words.unshift(env.toLowerCase());
    return {
      name: /^\\([A-Za-z]+)/.exec(insert)![1],
      label: env ? `\\begin{${env}}` : insert,
      insert,
      caret: marker >= 0 ? marker : slot >= 0 ? slot : insert.length,
      preview: preview ?? samplePreview(insert),
      keywords: words.map((word) => word.toLowerCase()),
      category,
    };
  });
}

const GREEK: Spec[] = [
  ["\\alpha", "greek letter angle"],
  ["\\beta", "greek letter"],
  ["\\gamma", "greek letter"],
  ["\\delta", "greek letter small change"],
  ["\\epsilon", "greek letter small"],
  ["\\varepsilon", "greek letter epsilon small"],
  ["\\zeta", "greek letter"],
  ["\\eta", "greek letter efficiency"],
  ["\\theta", "greek letter angle"],
  ["\\vartheta", "greek letter theta"],
  ["\\iota", "greek letter"],
  ["\\kappa", "greek letter curvature"],
  ["\\varkappa", "greek letter kappa"],
  ["\\lambda", "greek letter eigenvalue wavelength"],
  ["\\mu", "greek letter mean micro"],
  ["\\nu", "greek letter frequency"],
  ["\\xi", "greek letter"],
  ["\\pi", "greek letter circle"],
  ["\\varpi", "greek letter pi"],
  ["\\rho", "greek letter density"],
  ["\\varrho", "greek letter rho"],
  ["\\sigma", "greek letter standard deviation"],
  ["\\varsigma", "greek letter sigma final"],
  ["\\tau", "greek letter torque"],
  ["\\upsilon", "greek letter"],
  ["\\phi", "greek letter angle golden ratio"],
  ["\\varphi", "greek letter phi"],
  ["\\chi", "greek letter"],
  ["\\psi", "greek letter wave function"],
  ["\\omega", "greek letter angular frequency"],
  ["\\digamma", "greek letter"],
  ["\\Gamma", "greek letter capital function"],
  ["\\Delta", "greek letter capital change difference triangle"],
  ["\\Theta", "greek letter capital big theta"],
  ["\\Lambda", "greek letter capital"],
  ["\\Xi", "greek letter capital"],
  ["\\Pi", "greek letter capital product"],
  ["\\Sigma", "greek letter capital sum"],
  ["\\Upsilon", "greek letter capital"],
  ["\\Phi", "greek letter capital flux"],
  ["\\Psi", "greek letter capital"],
  ["\\Omega", "greek letter capital ohm big omega"],
  ["\\aleph", "hebrew cardinal infinity"],
  ["\\beth", "hebrew cardinal"],
  ["\\gimel", "hebrew"],
  ["\\daleth", "hebrew"],
];

const OPERATORS: Spec[] = [
  ["\\pm", "plus minus"],
  ["\\mp", "minus plus"],
  ["\\times", "multiply cross product"],
  ["\\div", "divide division"],
  ["\\cdot", "dot multiply product centered"],
  ["\\ast", "asterisk star convolution"],
  ["\\star", "star"],
  ["\\circ", "compose composition ring degree"],
  ["\\bullet", "bullet dot"],
  ["\\oplus", "direct sum xor circled plus"],
  ["\\ominus", "circled minus"],
  ["\\otimes", "tensor product circled times"],
  ["\\oslash", "circled slash"],
  ["\\odot", "circled dot hadamard"],
  ["\\cup", "union set"],
  ["\\cap", "intersection set"],
  ["\\sqcup", "disjoint union square cup"],
  ["\\sqcap", "square cap"],
  ["\\uplus", "multiset union"],
  ["\\setminus", "set difference minus backslash"],
  ["\\vee", "or logical join disjunction"],
  ["\\wedge", "and logical meet conjunction"],
  ["\\land", "and logical conjunction"],
  ["\\lor", "or logical disjunction"],
  ["\\neg", "not negation logical"],
  ["\\lnot", "not negation logical"],
  ["\\wr", "wreath product"],
  ["\\diamond", "diamond"],
  ["\\amalg", "amalgamation coproduct"],
  ["\\dagger", "dagger adjoint"],
  ["\\ddagger", "double dagger"],
  ["\\ltimes", "semidirect product"],
  ["\\rtimes", "semidirect product"],
  ["\\triangleleft", "triangle normal subgroup"],
  ["\\triangleright", "triangle"],
];

const RELATIONS: Spec[] = [
  ["\\leq", "less equal inequality"],
  ["\\geq", "greater equal inequality"],
  ["\\neq", "not equal unequal"],
  ["\\le", "less equal inequality"],
  ["\\ge", "greater equal inequality"],
  ["\\ne", "not equal unequal"],
  ["\\leqslant", "less equal slanted"],
  ["\\geqslant", "greater equal slanted"],
  ["\\ll", "much less"],
  ["\\gg", "much greater"],
  ["\\lesssim", "less approximately"],
  ["\\gtrsim", "greater approximately"],
  ["\\nless", "not less"],
  ["\\ngtr", "not greater"],
  ["\\nleq", "not less equal"],
  ["\\ngeq", "not greater equal"],
  ["\\equiv", "identical congruent equivalent modulo"],
  ["\\approx", "approximately equal"],
  ["\\sim", "similar tilde distributed"],
  ["\\simeq", "similar equal homotopic"],
  ["\\cong", "congruent isomorphic"],
  ["\\propto", "proportional"],
  ["\\asymp", "asymptotic"],
  ["\\doteq", "approaches limit"],
  ["\\triangleq", "defined equal delta"],
  ["\\coloneqq", "defined assign colon equal"],
  ["\\prec", "precedes"],
  ["\\succ", "succeeds"],
  ["\\preceq", "precedes equal"],
  ["\\succeq", "succeeds equal"],
  ["\\in", "element member belongs"],
  ["\\notin", "not element member"],
  ["\\ni", "contains member"],
  ["\\subset", "subset proper"],
  ["\\supset", "superset proper"],
  ["\\subseteq", "subset equal"],
  ["\\supseteq", "superset equal"],
  ["\\subsetneq", "proper subset not equal"],
  ["\\supsetneq", "proper superset not equal"],
  ["\\sqsubseteq", "square subset"],
  ["\\sqsupseteq", "square superset"],
  ["\\mid", "divides given conditional bar"],
  ["\\nmid", "not divides"],
  ["\\parallel", "parallel"],
  ["\\nparallel", "not parallel"],
  ["\\perp", "perpendicular orthogonal"],
  ["\\vdash", "proves turnstile"],
  ["\\dashv", "adjoint"],
  ["\\models", "entails satisfies"],
  ["\\vDash", "entails satisfies"],
  ["\\bowtie", "natural join"],
  ["\\smile", "smile"],
  ["\\frown", "frown"],
  ["\\lhd", "normal subgroup"],
  ["\\unlhd", "normal subgroup equal"],
];

const ARROWS: Spec[] = [
  ["\\to", "arrow right maps limit tends"],
  ["\\gets", "arrow left assign"],
  ["\\rightarrow", "arrow right"],
  ["\\leftarrow", "arrow left"],
  ["\\leftrightarrow", "arrow both"],
  ["\\Rightarrow", "arrow implies double right"],
  ["\\Leftarrow", "arrow implied double left"],
  ["\\Leftrightarrow", "arrow iff equivalent double both"],
  ["\\implies", "arrow implies then"],
  ["\\impliedby", "arrow implied"],
  ["\\iff", "arrow if only equivalent"],
  ["\\mapsto", "arrow maps function"],
  ["\\longrightarrow", "arrow right long"],
  ["\\longleftarrow", "arrow left long"],
  ["\\longleftrightarrow", "arrow both long"],
  ["\\Longrightarrow", "arrow implies long double"],
  ["\\Longleftarrow", "arrow long double left"],
  ["\\Longleftrightarrow", "arrow iff long double"],
  ["\\longmapsto", "arrow maps long"],
  ["\\uparrow", "arrow up"],
  ["\\downarrow", "arrow down"],
  ["\\updownarrow", "arrow up down"],
  ["\\Uparrow", "arrow up double"],
  ["\\Downarrow", "arrow down double"],
  ["\\Updownarrow", "arrow up down double"],
  ["\\nearrow", "arrow north east diagonal"],
  ["\\searrow", "arrow south east diagonal"],
  ["\\swarrow", "arrow south west diagonal"],
  ["\\nwarrow", "arrow north west diagonal"],
  ["\\hookrightarrow", "arrow injection inclusion embedding"],
  ["\\hookleftarrow", "arrow hook left"],
  ["\\twoheadrightarrow", "arrow surjection onto"],
  ["\\rightharpoonup", "arrow harpoon vector"],
  ["\\rightharpoondown", "arrow harpoon"],
  ["\\leftharpoonup", "arrow harpoon"],
  ["\\leftharpoondown", "arrow harpoon"],
  ["\\rightleftharpoons", "arrow equilibrium reversible reaction"],
  ["\\rightrightarrows", "arrow parallel double"],
  ["\\leftleftarrows", "arrow parallel double"],
  ["\\rightsquigarrow", "arrow squiggly leads"],
  ["\\leadsto", "arrow squiggly leads"],
  ["\\circlearrowleft", "arrow circle rotate counterclockwise"],
  ["\\circlearrowright", "arrow circle rotate clockwise"],
  ["\\curvearrowleft", "arrow curved"],
  ["\\curvearrowright", "arrow curved"],
  ["\\nrightarrow", "arrow not right"],
  ["\\nleftarrow", "arrow not left"],
  ["\\nRightarrow", "arrow not implies"],
  ["\\nLeftrightarrow", "arrow not iff"],
  ["\\xrightarrow{}", "arrow extensible labeled over right", "\\xrightarrow{f}"],
  ["\\xleftarrow{}", "arrow extensible labeled over left", "\\xleftarrow{f}"],
];

const BIG_OPERATORS: Spec[] = [
  ["\\sum", "sum summation sigma series"],
  ["\\prod", "product pi"],
  ["\\coprod", "coproduct"],
  ["\\int", "integral"],
  ["\\iint", "double integral"],
  ["\\iiint", "triple integral"],
  ["\\oint", "contour line integral closed"],
  ["\\bigcup", "union big"],
  ["\\bigcap", "intersection big"],
  ["\\bigsqcup", "disjoint union big"],
  ["\\bigoplus", "direct sum big"],
  ["\\bigotimes", "tensor product big"],
  ["\\bigodot", "circled dot big"],
  ["\\biguplus", "multiset union big"],
  ["\\bigvee", "or big join"],
  ["\\bigwedge", "and big meet"],
  ["\\lim", "limit"],
  ["\\limsup", "limit superior"],
  ["\\liminf", "limit inferior"],
  ["\\sup", "supremum least upper bound"],
  ["\\inf", "infimum greatest lower bound"],
  ["\\max", "maximum"],
  ["\\min", "minimum"],
  ["\\arg", "argument"],
  ["\\operatorname*{arg\\,max}", "argmax maximum argument", "\\operatorname*{arg\\,max}"],
  ["\\operatorname*{arg\\,min}", "argmin minimum argument", "\\operatorname*{arg\\,min}"],
];

const FUNCTIONS: Spec[] = [
  ["\\sin", "sine trigonometry"],
  ["\\cos", "cosine trigonometry"],
  ["\\tan", "tangent trigonometry"],
  ["\\cot", "cotangent trigonometry"],
  ["\\sec", "secant trigonometry"],
  ["\\csc", "cosecant trigonometry"],
  ["\\arcsin", "inverse sine trigonometry"],
  ["\\arccos", "inverse cosine trigonometry"],
  ["\\arctan", "inverse tangent trigonometry"],
  ["\\sinh", "hyperbolic sine"],
  ["\\cosh", "hyperbolic cosine"],
  ["\\tanh", "hyperbolic tangent"],
  ["\\coth", "hyperbolic cotangent"],
  ["\\exp", "exponential"],
  ["\\log", "logarithm"],
  ["\\ln", "natural logarithm"],
  ["\\lg", "logarithm base"],
  ["\\det", "determinant"],
  ["\\dim", "dimension"],
  ["\\ker", "kernel null space"],
  ["\\deg", "degree polynomial"],
  ["\\gcd", "greatest common divisor"],
  ["\\hom", "homomorphisms"],
  ["\\Pr", "probability"],
  ["\\bmod", "modulo remainder"],
  ["\\pmod{}", "modulo congruence parentheses"],
  ["\\operatorname{}", "operator function custom name", "\\operatorname{rank}"],
];

const STRUCTURES: Spec[] = [
  ["\\frac{}{}", "fraction divide over ratio"],
  ["\\dfrac{}{}", "fraction display large"],
  ["\\tfrac{}{}", "fraction text small"],
  ["\\cfrac{}{}", "continued fraction"],
  ["\\sqrt{}", "square root radical"],
  ["\\sqrt[]{}", "nth root cube radical index", "\\sqrt[n]{x}"],
  ["\\binom{}{}", "binomial choose combination", "\\binom{n}{k}"],
  ["\\dbinom{}{}", "binomial display", "\\dbinom{n}{k}"],
  ["\\tbinom{}{}", "binomial text", "\\tbinom{n}{k}"],
  ["\\overset{}{}", "over above stack"],
  ["\\underset{}{}", "under below stack"],
  ["\\stackrel{}{}", "stack relation over"],
  ["\\overbrace{}", "brace over group", "\\overbrace{a+b}"],
  ["\\underbrace{}", "brace under group", "\\underbrace{a+b}"],
  ["\\boxed{}", "box frame result"],
  ["\\left(§\\right)", "parentheses delimiter auto size", "\\left(x\\right)"],
  ["\\left[§\\right]", "brackets delimiter auto size", "\\left[x\\right]"],
  ["\\left\\{§\\right\\}", "braces delimiter auto size set", "\\left\\{x\\right\\}"],
  ["\\left|§\\right|", "absolute value delimiter auto size", "\\left|x\\right|"],
  ["\\left\\langle§\\right\\rangle", "angle delimiter auto size inner product", "\\left\\langle x\\right\\rangle"],
  ["\\displaystyle", "display style large", "\\displaystyle\\sum"],
  ["\\phantom{}", "invisible space placeholder", "a\\phantom{b}c"],
  ["\\hspace{§}", "horizontal space", "a\\hspace{1em}b"],
];

const ACCENTS: Spec[] = [
  ["\\hat{}", "hat caret estimator unit vector"],
  ["\\widehat{}", "hat wide", "\\widehat{ab}"],
  ["\\tilde{}", "tilde"],
  ["\\widetilde{}", "tilde wide", "\\widetilde{ab}"],
  ["\\bar{}", "bar mean average overline"],
  ["\\overline{}", "bar line over conjugate closure", "\\overline{ab}"],
  ["\\underline{}", "line under", "\\underline{ab}"],
  ["\\vec{}", "vector arrow"],
  ["\\overrightarrow{}", "vector arrow over long", "\\overrightarrow{AB}"],
  ["\\overleftarrow{}", "arrow over left", "\\overleftarrow{AB}"],
  ["\\overleftrightarrow{}", "arrow over both line", "\\overleftrightarrow{AB}"],
  ["\\dot{}", "dot derivative time"],
  ["\\ddot{}", "double dot second derivative"],
  ["\\acute{}", "acute accent"],
  ["\\grave{}", "grave accent"],
  ["\\breve{}", "breve accent"],
  ["\\check{}", "check caron accent"],
  ["\\mathring{}", "ring accent"],
  ["\\cancel{}", "cancel strike cross out"],
  ["\\bcancel{}", "cancel strike back"],
  ["\\xcancel{}", "cancel cross x"],
];

const FONTS: Spec[] = [
  ["\\text{}", "text words roman plain", "\\text{text}"],
  ["\\mathrm{}", "roman upright", "\\mathrm{d}"],
  ["\\mathbf{}", "bold vector", "\\mathbf{v}"],
  ["\\boldsymbol{}", "bold symbol greek", "\\boldsymbol{\\alpha}"],
  ["\\mathit{}", "italic", "\\mathit{x}"],
  ["\\mathsf{}", "sans serif", "\\mathsf{A}"],
  ["\\mathtt{}", "typewriter monospace", "\\mathtt{A}"],
  ["\\mathcal{}", "calligraphic script", "\\mathcal{L}"],
  ["\\mathscr{}", "script", "\\mathscr{L}"],
  ["\\mathbb{}", "blackboard double struck sets real numbers", "\\mathbb{R}"],
  ["\\mathfrak{}", "fraktur gothic lie algebra", "\\mathfrak{g}"],
  ["\\color{§}{}", "color colour", "\\color{red}{x}"],
  ["\\textcolor{§}{}", "color colour text", "\\textcolor{blue}{x}"],
];

const SYMBOLS: Spec[] = [
  ["\\infty", "infinity"],
  ["\\partial", "partial derivative"],
  ["\\nabla", "gradient del nabla divergence"],
  ["\\forall", "for all every quantifier"],
  ["\\exists", "there exists quantifier"],
  ["\\nexists", "not exists"],
  ["\\emptyset", "empty set null"],
  ["\\varnothing", "empty set null"],
  ["\\top", "true top tautology"],
  ["\\bot", "false bottom contradiction"],
  ["\\angle", "angle"],
  ["\\measuredangle", "angle measured"],
  ["\\triangle", "triangle"],
  ["\\square", "square box"],
  ["\\blacksquare", "qed end proof square"],
  ["\\Box", "box square modal necessity"],
  ["\\Diamond", "diamond modal possibility"],
  ["\\ell", "script l length"],
  ["\\hbar", "planck reduced constant"],
  ["\\imath", "dotless i"],
  ["\\jmath", "dotless j"],
  ["\\Re", "real part"],
  ["\\Im", "imaginary part"],
  ["\\wp", "weierstrass power set"],
  ["\\prime", "prime derivative apostrophe"],
  ["\\degree", "degree temperature angle"],
  ["\\ldots", "dots ellipsis low"],
  ["\\cdots", "dots ellipsis centered"],
  ["\\vdots", "dots vertical"],
  ["\\ddots", "dots diagonal"],
  ["\\therefore", "therefore hence"],
  ["\\because", "because since"],
  ["\\checkmark", "check tick"],
  ["\\S", "section"],
  ["\\P", "paragraph pilcrow"],
  ["\\clubsuit", "club card suit"],
  ["\\diamondsuit", "diamond card suit"],
  ["\\heartsuit", "heart card suit"],
  ["\\spadesuit", "spade card suit"],
  ["\\flat", "music flat"],
  ["\\natural", "music natural"],
  ["\\sharp", "music sharp"],
  ["\\complement", "complement set"],
  ["\\mho", "conductance"],
  ["\\eth", "eth"],
  ["\\Bbbk", "blackboard k field"],
  ["\\bigstar", "star big"],
  ["\\lozenge", "lozenge diamond"],
  ["\\surd", "root radical"],
  ["\\backslash", "backslash"],
];

const DELIMITERS: Spec[] = [
  ["\\langle", "angle bracket inner product left"],
  ["\\rangle", "angle bracket inner product right"],
  ["\\lceil", "ceiling left"],
  ["\\rceil", "ceiling right"],
  ["\\lfloor", "floor left"],
  ["\\rfloor", "floor right"],
  ["\\lvert", "absolute value bar left"],
  ["\\rvert", "absolute value bar right"],
  ["\\lVert", "norm double bar left"],
  ["\\rVert", "norm double bar right"],
  ["\\vert", "bar absolute value"],
  ["\\Vert", "norm double bar"],
  ["\\lbrace", "brace curly set left"],
  ["\\rbrace", "brace curly set right"],
  ["\\lbrack", "bracket square left"],
  ["\\rbrack", "bracket square right"],
];

const SPACING: Spec[] = [
  ["\\quad", "space wide em", "a\\quad b"],
  ["\\qquad", "space double wide", "a\\qquad b"],
  ["\\enspace", "space half", "a\\enspace b"],
  ["\\thinspace", "space thin", "a\\thinspace b"],
];

const MATRIX_PREVIEW = "a & b \\\\ c & d";

const ENVIRONMENTS: Spec[] = [
  ["\\begin{matrix} § \\end{matrix}", "matrix plain", `\\begin{matrix}${MATRIX_PREVIEW}\\end{matrix}`],
  ["\\begin{pmatrix} § \\end{pmatrix}", "matrix parentheses", `\\begin{pmatrix}${MATRIX_PREVIEW}\\end{pmatrix}`],
  ["\\begin{bmatrix} § \\end{bmatrix}", "matrix brackets", `\\begin{bmatrix}${MATRIX_PREVIEW}\\end{bmatrix}`],
  ["\\begin{Bmatrix} § \\end{Bmatrix}", "matrix braces", `\\begin{Bmatrix}${MATRIX_PREVIEW}\\end{Bmatrix}`],
  ["\\begin{vmatrix} § \\end{vmatrix}", "matrix determinant bars", `\\begin{vmatrix}${MATRIX_PREVIEW}\\end{vmatrix}`],
  ["\\begin{Vmatrix} § \\end{Vmatrix}", "matrix norm double bars", `\\begin{Vmatrix}${MATRIX_PREVIEW}\\end{Vmatrix}`],
  ["\\begin{smallmatrix} § \\end{smallmatrix}", "matrix small inline", `\\begin{smallmatrix}${MATRIX_PREVIEW}\\end{smallmatrix}`],
  ["\\begin{cases} § \\end{cases}", "cases piecewise conditions", "\\begin{cases}a & x \\\\ b & y\\end{cases}"],
  ["\\begin{aligned} § \\end{aligned}", "align equations lines", "\\begin{aligned}a&=b \\\\ c&=d\\end{aligned}"],
  ["\\begin{gathered} § \\end{gathered}", "gather centered lines", "\\begin{gathered}a \\\\ b\\end{gathered}"],
  ["\\begin{array}{§}  \\end{array}", "array table columns", "\\begin{array}{cc}a & b \\\\ c & d\\end{array}"],
];

export const LATEX_ENTRIES: LatexEntry[] = [
  ...group("Greek", GREEK),
  ...group("Operator", OPERATORS),
  ...group("Relation", RELATIONS),
  ...group("Arrow", ARROWS),
  ...group("Big operator", BIG_OPERATORS),
  ...group("Function", FUNCTIONS),
  ...group("Structure", STRUCTURES),
  ...group("Accent", ACCENTS),
  ...group("Font", FONTS),
  ...group("Symbol", SYMBOLS),
  ...group("Delimiter", DELIMITERS),
  ...group("Spacing", SPACING),
  ...group("Environment", ENVIRONMENTS),
];

/**
 * Commands that look alike or get mixed up, with what sets each one apart.
 * Every member of a group lists the others as similar.
 */
export const LOOKALIKES: [label: string, note: string][][] = [
  [
    ["\\epsilon", "Lunate ϵ, looks like a small ∈. Classic \"small quantity\" in analysis, but easy to confuse with set membership."],
    ["\\varepsilon", "Rounded ε, like a backwards 3. Often preferred because it can't be mistaken for ∈."],
    ["\\in", "Not a letter: the \"is an element of\" relation, with relation spacing on both sides."],
  ],
  [
    ["\\phi", "Straight stroke through a circle. The textbook form for the golden ratio and angles."],
    ["\\varphi", "Looped, handwritten-style form. Picked for functions, potentials and Euler's totient."],
    ["\\Phi", "Capital letter. Flux, or the normal distribution's CDF."],
  ],
  [
    ["\\theta", "Closed oval with a bar. The default for angles and parameters."],
    ["\\vartheta", "Cursive, open form. Use it when θ already means something else."],
  ],
  [
    ["\\rho", "Straight tail. The default for density and correlation."],
    ["\\varrho", "Curled tail. A second rho when ρ is taken."],
  ],
  [
    ["\\sigma", "Lowercase σ. Standard deviation, stress."],
    ["\\varsigma", "Word-final Greek ς. Almost never what you want in math."],
    ["\\Sigma", "Just the capital letter: stays small and won't take limits. Fine for a covariance matrix, wrong for sums."],
    ["\\sum", "The summation operator: grows in display mode and puts limits above and below."],
  ],
  [
    ["\\Pi", "Just the capital letter: stays small, no limits. Use \\prod for products."],
    ["\\prod", "The product operator: grows and takes limits like \\sum."],
  ],
  [
    ["\\Delta", "A letter, spaced as one. Change in a quantity, Laplacian."],
    ["\\triangle", "A shape, not a letter: thinner lines, used for geometric triangles."],
    ["\\nabla", "Points down. The vector operator for gradient, divergence and curl."],
  ],
  [
    ["\\partial", "Curled d for partial derivatives, where the other variables are held fixed."],
    ["\\delta", "A Greek letter, not a derivative: small change, Kronecker or Dirac delta."],
  ],
  [
    ["\\leq", "Flat bar under <. The standard ≤."],
    ["\\le", "Identical output to \\leq, just shorter to type."],
    ["\\leqslant", "Bar slanted parallel to <. Same meaning, a style common in European texts."],
  ],
  [
    ["\\geq", "Flat bar under >. The standard ≥."],
    ["\\ge", "Identical output to \\geq, just shorter to type."],
    ["\\geqslant", "Bar slanted parallel to >. Same meaning, a style common in European texts."],
  ],
  [
    ["\\neq", "The standard ≠."],
    ["\\ne", "Identical output to \\neq, just shorter to type."],
  ],
  [
    ["\\sim", "One tilde: loosely alike. X ∼ N(0,1), or same growth rate."],
    ["\\approx", "Two tildes: numerically close, π ≈ 3.14."],
    ["\\simeq", "Tilde over one bar: asymptotically equal, homotopy equivalent."],
    ["\\cong", "Tilde over two bars: same structure. Congruent shapes, isomorphic objects."],
    ["\\equiv", "Three bars, no tilde: always equal, or congruent mod n."],
  ],
  [
    ["\\triangleq", "Small triangle on =. Equal by definition, common in engineering."],
    ["\\coloneqq", "Colon before =. Defines the left side: x := y. Common in CS and math."],
  ],
  [
    ["\\vert", "Plain bar with no spacing role. Same as typing |; spacing can go wrong in |-x|."],
    ["\\mid", "Same bar with space on both sides, like a relation: a ∣ b, {x ∣ x > 0}, P(A ∣ B)."],
    ["\\lvert", "Marked as an opening delimiter, so |-x| spaces correctly. Pair with \\rvert."],
    ["\\rvert", "Marked as a closing delimiter. Pair with \\lvert."],
  ],
  [
    ["\\Vert", "Plain double bar with no spacing role, like typing \\|."],
    ["\\parallel", "Double bar with relation spacing: AB ∥ CD."],
    ["\\lVert", "Opening delimiter for norms ‖v‖, spaced correctly. Pair with \\rVert."],
    ["\\rVert", "Closing delimiter for norms. Pair with \\lVert."],
  ],
  [
    ["\\to", "Short arrow. Limits and function types, f: A \\to B."],
    ["\\rightarrow", "Identical output to \\to. Reads better for reactions and transitions."],
    ["\\mapsto", "Arrow with a bar: where an element goes, x \\mapsto x^2."],
    ["\\longrightarrow", "Longer version, for long labels or emphasis."],
  ],
  [
    ["\\Rightarrow", "Short double arrow with relation spacing. Fine inside formulas."],
    ["\\implies", "Long double arrow with wide spacing, for logical implication."],
    ["\\Longrightarrow", "Long double arrow without the extra spacing."],
  ],
  [
    ["\\Leftrightarrow", "Short double two-way arrow with relation spacing."],
    ["\\iff", "Long double arrow with wide spacing, for if and only if."],
  ],
  [
    ["\\hookrightarrow", "Hooked arrow: injection or inclusion."],
    ["\\twoheadrightarrow", "Two heads: surjection."],
  ],
  [
    ["\\emptyset", "Tall oval with a slash, like a slashed zero. The traditional TeX look."],
    ["\\varnothing", "Round circle with a slash. Matches how ∅ is usually handwritten."],
  ],
  [
    ["\\subset", "No bar. Ambiguous: some authors mean any subset, others proper only."],
    ["\\subseteq", "Bar underneath: may be equal. Unambiguous."],
    ["\\subsetneq", "Slashed bar: definitely not equal. Unambiguous proper subset."],
  ],
  [
    ["\\setminus", "Backslash with operator spacing: A ∖ B."],
    ["\\backslash", "Same glyph with no spacing. Quotients like G\\backslash X."],
  ],
  [
    ["\\wedge", "Pointed ∧. Logical and, meet, exterior product."],
    ["\\land", "Identical output to \\wedge; the name says you mean logical and."],
    ["\\cap", "Rounded ∩. Set intersection, not logic."],
  ],
  [
    ["\\vee", "Pointed ∨. Logical or, join."],
    ["\\lor", "Identical output to \\vee; the name says you mean logical or."],
    ["\\cup", "Rounded ∪. Set union, not logic."],
  ],
  [
    ["\\neg", "Logical not ¬."],
    ["\\lnot", "Identical output to \\neg."],
  ],
  [
    ["\\cdot", "Centered dot. Scalar or dot product."],
    ["\\times", "Cross. Cross product, dimensions, plain multiplication."],
    ["\\ast", "Centered asterisk. Convolution."],
    ["\\bullet", "Large filled dot. A placeholder argument, f(•)."],
    ["\\circ", "Small ring. Composition."],
  ],
  [
    ["\\ldots", "Dots on the baseline, for lists: 1, 2, \\ldots"],
    ["\\cdots", "Centered dots, between operators: a + \\cdots + z"],
    ["\\vdots", "Vertical dots, in matrices and columns."],
    ["\\ddots", "Diagonal dots, in matrices."],
  ],
  [
    ["\\langle", "Wide bracket with delimiter spacing: ⟨u, v⟩. Typing < gives a cramped less-than sign."],
    ["\\rangle", "Closing ⟩ to pair with \\langle."],
  ],
  [
    ["\\square", "Empty square, a general symbol or placeholder."],
    ["\\Box", "Square spaced for modal logic: □p, p is necessary."],
    ["\\blacksquare", "Filled square, the end-of-proof mark ∎."],
  ],
  [
    ["\\frac{}{}", "Fraction that shrinks inline and grows in display mode."],
    ["\\dfrac{}{}", "Always display size, even inline."],
    ["\\tfrac{}{}", "Always small text size."],
    ["\\cfrac{}{}", "For continued fractions; keeps nested levels full size."],
  ],
  [
    ["\\bar{}", "Short fixed-width bar over one symbol."],
    ["\\overline{}", "Line that stretches over the whole expression."],
  ],
  [
    ["\\hat{}", "Small hat over one symbol."],
    ["\\widehat{}", "Hat that stretches over several symbols."],
  ],
  [
    ["\\tilde{}", "Small tilde over one symbol."],
    ["\\widetilde{}", "Tilde that stretches over several symbols."],
  ],
  [
    ["\\vec{}", "Small arrow over one symbol."],
    ["\\overrightarrow{}", "Arrow that stretches over the whole expression, like \\overrightarrow{AB}."],
  ],
  [
    ["\\text{}", "Normal text with spaces kept, in the surrounding text font."],
    ["\\mathrm{}", "Upright math letters; spaces are ignored. Units, the d in dx."],
    ["\\operatorname{}", "Upright name with operator spacing, like a new \\sin."],
  ],
  [
    ["\\mathbf{}", "Upright bold. Latin letters only."],
    ["\\boldsymbol{}", "Bold that keeps italics and works on Greek letters."],
  ],
  [
    ["\\mathbb{}", "Blackboard bold, capitals only: ℝ, ℕ, ℤ."],
    ["\\mathcal{}", "Calligraphic capitals."],
    ["\\mathscr{}", "Script capitals, more ornate than \\mathcal."],
    ["\\mathfrak{}", "Fraktur. Lie algebras, ideals."],
  ],
  [
    ["\\bmod", "Binary mod: a \\bmod b."],
    ["\\pmod{}", "Mod in parentheses after a congruence: a \\equiv b \\pmod{n}."],
  ],
  [
    ["\\quad", "Space of 1em."],
    ["\\qquad", "Space of 2em."],
    ["\\enspace", "Space of half an em."],
    ["\\thinspace", "Thin space, the same as \\,"],
  ],
  [
    ["\\int", "Single integral over an interval or region."],
    ["\\oint", "Integral over a closed curve."],
    ["\\iint", "Double integral, signs tucked closer than \\int\\int would place them."],
  ],
  [
    ["\\sup", "Least upper bound, which may not be reached: sup (0,1) = 1."],
    ["\\max", "Largest value that is actually reached. Undefined for (0,1)."],
  ],
  [
    ["\\inf", "Greatest lower bound, which may not be reached. Not infinity, that's \\infty."],
    ["\\min", "Smallest value that is actually reached."],
    ["\\infty", "Infinity ∞, a symbol rather than an operator."],
  ],
  [
    ["\\begin{matrix}", "No delimiters."],
    ["\\begin{pmatrix}", "Parentheses ( )."],
    ["\\begin{bmatrix}", "Square brackets [ ]."],
    ["\\begin{Bmatrix}", "Curly braces { }."],
    ["\\begin{vmatrix}", "Single bars, a determinant."],
    ["\\begin{Vmatrix}", "Double bars, a norm."],
  ],
  [
    ["\\begin{aligned}", "Lines aligned at & marks, usually at the = sign."],
    ["\\begin{gathered}", "Centered lines with no alignment."],
    ["\\begin{cases}", "Piecewise definition with a left brace."],
  ],
];

const byLabel = new Map(LATEX_ENTRIES.map((entry) => [entry.label, entry]));
for (const members of LOOKALIKES) {
  for (const [label, note] of members) {
    const entry = byLabel.get(label);
    if (!entry) continue;
    entry.note = note;
    entry.similar = members
      .map(([other]) => byLabel.get(other))
      .filter((other): other is LatexEntry => !!other && other !== entry);
  }
}

function isSubsequence(needle: string, haystack: string) {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index++;
    if (index === needle.length) return true;
  }
  return false;
}

// Lower is better. `strict` keeps only matches on the command name itself.
function matchTier(entry: LatexEntry, query: string, lower: string, strict: boolean) {
  const name = entry.name;
  const nameLower = name.toLowerCase();
  if (name === query) return 0;
  if (nameLower === lower) return 1;
  if (name.startsWith(query)) return 2;
  if (nameLower.startsWith(lower)) return 3;
  if (strict) return -1;
  if (entry.keywords.some((word) => word.startsWith(lower))) return 4;
  if (nameLower.includes(lower)) return 5;
  if (lower.length > 1 && isSubsequence(lower, nameLower)) return 6;
  return -1;
}

export function searchLatex(
  query: string,
  {
    usage = {},
    strict = false,
    limit = 50,
  }: { usage?: Record<string, number>; strict?: boolean; limit?: number } = {},
) {
  if (!query) return [];
  const lower = query.toLowerCase();
  const ranked: { entry: LatexEntry; tier: number; index: number }[] = [];
  LATEX_ENTRIES.forEach((entry, index) => {
    const tier = matchTier(entry, query, lower, strict);
    if (tier >= 0) ranked.push({ entry, tier, index });
  });
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      (usage[b.entry.label] ?? 0) - (usage[a.entry.label] ?? 0) ||
      a.entry.name.length - b.entry.name.length ||
      a.index - b.index,
  );
  return ranked.slice(0, limit).map(({ entry }) => entry);
}
