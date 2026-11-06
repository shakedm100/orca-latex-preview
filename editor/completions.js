// LaTeX completions for the source pane: commands, environments (with their \end), packages,
// and from the project: labels for \ref, keys for \cite, user commands, files to \input or show.
import { snippetCompletion } from './vendor/codemirror.mjs'

const COMMANDS = [
  // [name, snippet after the backslash, detail]
  ['section', 'section{${title}}', 'heading'],
  ['subsection', 'subsection{${title}}', 'heading'],
  ['subsubsection', 'subsubsection{${title}}', 'heading'],
  ['chapter', 'chapter{${title}}', 'heading'],
  ['paragraph', 'paragraph{${title}}', 'heading'],
  ['part', 'part{${title}}', 'heading'],
  ['label', 'label{${key}}', 'cross-reference'],
  ['ref', 'ref{${key}}', 'cross-reference'],
  ['eqref', 'eqref{${key}}', 'cross-reference'],
  ['pageref', 'pageref{${key}}', 'cross-reference'],
  ['autoref', 'autoref{${key}}', 'hyperref'],
  ['cref', 'cref{${key}}', 'cleveref'],
  ['Cref', 'Cref{${key}}', 'cleveref'],
  ['cite', 'cite{${key}}', 'citation'],
  ['citep', 'citep{${key}}', 'natbib'],
  ['citet', 'citet{${key}}', 'natbib'],
  ['parencite', 'parencite{${key}}', 'biblatex'],
  ['textcite', 'textcite{${key}}', 'biblatex'],
  ['footnote', 'footnote{${text}}', ''],
  ['emph', 'emph{${text}}', 'emphasis'],
  ['textbf', 'textbf{${text}}', 'bold'],
  ['textit', 'textit{${text}}', 'italic'],
  ['texttt', 'texttt{${text}}', 'monospace'],
  ['textsc', 'textsc{${text}}', 'small caps'],
  ['underline', 'underline{${text}}', ''],
  ['url', 'url{${address}}', 'hyperref'],
  ['href', 'href{${address}}{${text}}', 'hyperref'],
  ['includegraphics', 'includegraphics[width=${0.8}\\linewidth]{${file}}', 'graphicx'],
  ['input', 'input{${file}}', 'include a file'],
  ['include', 'include{${file}}', 'include a chapter'],
  ['caption', 'caption{${text}}', 'float caption'],
  ['centering', 'centering', ''],
  ['item', 'item ${}', 'list item'],
  ['frac', 'frac{${a}}{${b}}', 'math'],
  ['sqrt', 'sqrt{${x}}', 'math'],
  ['sum', 'sum_{${i=1}}^{${n}}', 'math'],
  ['int', 'int_{${a}}^{${b}}', 'math'],
  ['mathbf', 'mathbf{${x}}', 'math'],
  ['mathrm', 'mathrm{${x}}', 'math'],
  ['mathcal', 'mathcal{${X}}', 'math'],
  ['mathbb', 'mathbb{${R}}', 'math'],
  ['left', 'left( ${} \\right)', 'math delimiters'],
  ['usepackage', 'usepackage{${package}}', 'preamble'],
  ['documentclass', 'documentclass{${article}}', 'preamble'],
  ['newcommand', 'newcommand{${}}[${1}]{${definition}}', 'preamble'],
  ['renewcommand', 'renewcommand{${}}{${definition}}', 'preamble'],
  ['title', 'title{${title}}', 'preamble'],
  ['author', 'author{${name}}', 'preamble'],
  ['date', 'date{${\\today}}', 'preamble'],
  ['maketitle', 'maketitle', ''],
  ['tableofcontents', 'tableofcontents', ''],
  ['listoffigures', 'listoffigures', ''],
  ['listoftables', 'listoftables', ''],
  ['bibliography', 'bibliography{${refs}}', 'BibTeX'],
  ['bibliographystyle', 'bibliographystyle{${plain}}', 'BibTeX'],
  ['addbibresource', 'addbibresource{${refs.bib}}', 'biblatex'],
  ['printbibliography', 'printbibliography', 'biblatex'],
  ['newpage', 'newpage', ''],
  ['clearpage', 'clearpage', ''],
  ['vspace', 'vspace{${1em}}', ''],
  ['hspace', 'hspace{${1em}}', ''],
  ['noindent', 'noindent', ''],
  ['today', 'today', ''],
  ['ldots', 'ldots', ''],
  ['quad', 'quad', 'math space'],
  ['qquad', 'qquad', 'math space'],
  ['textwidth', 'textwidth', 'length'],
  ['linewidth', 'linewidth', 'length'],
  ['hline', 'hline', 'table rule'],
  ['toprule', 'toprule', 'booktabs'],
  ['midrule', 'midrule', 'booktabs'],
  ['bottomrule', 'bottomrule', 'booktabs'],
  ['multicolumn', 'multicolumn{${2}}{${c}}{${text}}', 'table'],
  ['textcolor', 'textcolor{${red}}{${text}}', 'xcolor']
]
const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega'.split(' ')
const SYMBOLS = 'leq geq neq approx equiv sim cdot times infty partial nabla forall exists in notin subset subseteq cup cap rightarrow leftarrow Rightarrow Leftrightarrow mapsto ldots cdots pm mp'.split(' ')

const ENVIRONMENTS = [
  ['itemize', '\t\\item ${}', 'bulleted list'],
  ['enumerate', '\t\\item ${}', 'numbered list'],
  ['description', '\t\\item[${term}] ${}', 'description list'],
  ['figure', '\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}', 'float', '[htbp]'],
  ['table', '\t\\centering\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\t\\begin{tabular}{${ll}}\n\t\t${}\n\t\\end{tabular}', 'float', '[htbp]'],
  ['tabular', '\t${}', 'table body', '{${ll}}'],
  ['equation', '\t${}', 'numbered equation'],
  ['equation*', '\t${}', 'unnumbered equation'],
  ['align', '\t${}', 'amsmath'],
  ['align*', '\t${}', 'amsmath'],
  ['gather', '\t${}', 'amsmath'],
  ['multline', '\t${}', 'amsmath'],
  ['cases', '\t${} & ${}', 'amsmath'],
  ['matrix', '\t${}', 'amsmath'],
  ['pmatrix', '\t${}', 'amsmath'],
  ['bmatrix', '\t${}', 'amsmath'],
  ['center', '\t${}', ''],
  ['flushleft', '\t${}', ''],
  ['flushright', '\t${}', ''],
  ['quote', '\t${}', ''],
  ['quotation', '\t${}', ''],
  ['verbatim', '${}', ''],
  ['lstlisting', '${}', 'listings'],
  ['minted', '${}', 'minted', '{${python}}'],
  ['abstract', '\t${}', ''],
  ['document', '${}', ''],
  ['minipage', '\t${}', '', '{${0.45}\\linewidth}'],
  ['subfigure', '\t${}', 'subcaption', '{${0.45}\\linewidth}'],
  ['tikzpicture', '\t${}', 'TikZ'],
  ['frame', '\t\\frametitle{${title}}\n\t${}', 'beamer'],
  ['theorem', '\t${}', 'amsthm'],
  ['lemma', '\t${}', 'amsthm'],
  ['proof', '\t${}', 'amsthm'],
  ['definition', '\t${}', 'amsthm'],
  ['thebibliography', '\t\\bibitem{${key}} ${}', '', '{${99}}']
]
const PACKAGES =
  'amsmath amssymb amsthm mathtools graphicx hyperref cleveref xcolor geometry booktabs tabularx longtable multirow array siunitx enumitem caption subcaption float listings minted tikz pgfplots biblatex natbib inputenc fontenc babel polyglossia fontspec microtype lmodern setspace fancyhdr titlesec parskip csquotes url algorithm algorithmic algpseudocode xspace todonotes lipsum blindtext appendix makeidx glossaries acronym import standalone tcolorbox mdframed'.split(' ')

// Whole blocks, offered when their name starts a line.
const BLOCKS = [
  ['figure', '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}', 'figure block'],
  ['table', '\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\t\\begin{tabular}{${ll}}\n\t\t\\toprule\n\t\t${A} & ${B} \\\\\n\t\t\\midrule\n\t\t${} \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}', 'table block (booktabs)'],
  ['equation', '\\begin{equation}\n\t${}\n\t\\label{eq:${label}}\n\\end{equation}', 'numbered equation'],
  ['align', '\\begin{align}\n\t${a} &= ${b} \\\\\n\t${c} &= ${d}\n\\end{align}', 'aligned equations'],
  ['itemize', '\\begin{itemize}\n\t\\item ${}\n\\end{itemize}', 'bulleted list'],
  ['enumerate', '\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}', 'numbered list'],
  ['subfigures', '\\begin{figure}[htbp]\n\t\\centering\n\t\\begin{subfigure}{0.48\\linewidth}\n\t\t\\includegraphics[width=\\linewidth]{${left}}\n\t\t\\caption{${}}\n\t\\end{subfigure}\n\t\\hfill\n\t\\begin{subfigure}{0.48\\linewidth}\n\t\t\\includegraphics[width=\\linewidth]{${right}}\n\t\t\\caption{${}}\n\t\\end{subfigure}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}', 'two figures side by side (subcaption)'],
  ['frame', '\\begin{frame}{${title}}\n\t${}\n\\end{frame}', 'beamer slide']
]

// Completions replace the typed backslash too, so each one writes it back.
const commandOptions = COMMANDS.map(([name, snippet, detail]) => snippetCompletion(`\\${snippet}`, { label: `\\${name}`, detail, type: 'function' }))
  .concat(GREEK.map((name) => ({ label: `\\${name}`, apply: `\\${name}`, detail: 'Greek letter', type: 'constant' })))
  .concat(SYMBOLS.map((name) => ({ label: `\\${name}`, apply: `\\${name}`, detail: 'math symbol', type: 'constant' })))

/** A `\begin{...}` completion that writes the matching \end and puts the cursor inside. */
function environmentOption(name, body = '\t${}', detail = '', argument = '') {
  return snippetCompletion(`${name}}${argument}\n${body}\n\\end{${name}}`, { label: name, detail: detail || 'environment', type: 'class' })
}

/** @param {() => any} getProject  the latest `latex.project` answer, or null */
export function latexCompletions(getProject) {
  return (context) => {
    const project = getProject() ?? {}
    const text = context.state.doc.toString()

    // \ref{...}, \eqref{...}, \cref{a,b}: labels from the project and this buffer.
    let match = context.matchBefore(/\\(?:[cC]?ref|eqref|autoref|pageref|nameref|vref|labelcref|cpageref)\*?\{[^}]*$/)
    if (match) {
      const from = match.from + match.text.lastIndexOf(match.text.includes(',') ? ',' : '{') + 1
      const seen = new Set()
      const options = []
      for (const found of text.matchAll(/\\label\s*\{([^}]+)\}/g)) {
        if (!seen.has(found[1])) {
          seen.add(found[1])
          options.push({ label: found[1], detail: 'this file', type: 'variable' })
        }
      }
      for (const label of project.labels ?? []) {
        if (!seen.has(label.name)) {
          seen.add(label.name)
          options.push({ label: label.name, detail: label.file.split('/').pop(), type: 'variable' })
        }
      }
      return { from, options, validFor: /^[^},]*$/ }
    }

    // \cite{...} and friends, with optional [pre][post] notes.
    match = context.matchBefore(/\\(?:no|auto|paren|text|foot|full|super)?[cC]ite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{[^}]*$/)
    if (match) {
      const from = match.from + Math.max(match.text.lastIndexOf('{'), match.text.lastIndexOf(',')) + 1
      const options = (project.citations ?? []).map((entry) => ({
        label: entry.key,
        detail: [entry.author.split(/\s+and\s+/)[0]?.split(',')[0], entry.year].filter(Boolean).join(' '),
        info: [entry.title, entry.venue].filter(Boolean).join('\n') || undefined,
        type: 'text'
      }))
      return { from, options, validFor: /^[^},]*$/ }
    }

    // \begin{...} writes the \end; \end{...} closes the innermost open environment.
    match = context.matchBefore(/\\begin\{[^}]*$/)
    if (match) {
      const from = match.from + 7
      const known = new Set(ENVIRONMENTS.map(([name]) => name))
      const options = ENVIRONMENTS.map(([name, body, detail, argument]) => environmentOption(name, body, detail, argument)).concat(
        (project.environments ?? [])
          .filter((env) => !known.has(env.name))
          .map((env) => environmentOption(env.name, '\t${}', 'defined in project', env.args ? '{${}}'.repeat(env.args) : ''))
      )
      return { from, options, validFor: /^[A-Za-z*]*$/ }
    }
    match = context.matchBefore(/\\end\{[^}]*$/)
    if (match) {
      const before = text.slice(0, match.from)
      const stack = []
      for (const found of before.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
        if (found[1] === 'begin') stack.push(found[2])
        else if (stack[stack.length - 1] === found[2]) stack.pop()
      }
      const open = [...new Set(stack.reverse())]
      return { from: match.from + 5, options: open.map((name, i) => ({ label: name, apply: `${name}}`, boost: 50 - i, type: 'class' })), validFor: /^[A-Za-z*]*$/ }
    }

    // Packages.
    match = context.matchBefore(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*$/)
    if (match) {
      const from = match.from + Math.max(match.text.lastIndexOf('{'), match.text.lastIndexOf(',')) + 1
      return { from, options: PACKAGES.map((name) => ({ label: name, type: 'namespace' })), validFor: /^[^},]*$/ }
    }

    // Files: images for \includegraphics, .tex for \input and \include, .bib for bibliographies.
    match = context.matchBefore(/\\includegraphics(?:\[[^\]]*\])?\{[^}]*$/)
    if (match) {
      return { from: match.from + match.text.lastIndexOf('{') + 1, options: (project.files?.images ?? []).map((file) => ({ label: file, type: 'text' })), validFor: /^[^}]*$/ }
    }
    match = context.matchBefore(/\\(?:input|include|subfile)\{[^}]*$/)
    if (match) {
      return { from: match.from + match.text.lastIndexOf('{') + 1, options: (project.files?.tex ?? []).map((file) => ({ label: file, type: 'text' })), validFor: /^[^}]*$/ }
    }
    match = context.matchBefore(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{[^}]*$/)
    if (match) {
      const bare = match.text.startsWith('\\bibliography')
      const files = (project.files?.bib ?? []).map((file) => (bare ? file.replace(/\.bib$/, '') : file))
      return { from: match.from + match.text.lastIndexOf('{') + 1, options: files.map((file) => ({ label: file, type: 'text' })), validFor: /^[^}]*$/ }
    }

    // A block name typed alone at the start of a line (fig, tab, eq, item...) offers the whole block.
    match = context.matchBefore(/^\s*[a-z]{3,}$/)
    if (match) {
      const word = match.text.trim()
      const options = BLOCKS.filter(([name]) => name.startsWith(word))
      if (options.length) {
        return {
          from: match.to - word.length,
          options: options.map(([name, body, detail]) => snippetCompletion(body, { label: name, detail, type: 'keyword', boost: -10 })),
          validFor: /^[a-z]*$/
        }
      }
    }

    // Commands.
    match = context.matchBefore(/\\[A-Za-z@]*$/)
    if (match && (match.text.length > 1 || context.explicit)) {
      const builtIn = new Set(commandOptions.map((option) => option.label))
      const mine = (project.commands ?? [])
        .filter((command) => !builtIn.has(`\\${command.name}`))
        .map((command) =>
          command.args
            ? snippetCompletion(`\\${command.name}${'{${}}'.repeat(command.args)}`, { label: `\\${command.name}`, detail: 'defined in project', type: 'function', boost: 5 })
            : { label: `\\${command.name}`, apply: `\\${command.name}`, detail: 'defined in project', type: 'function', boost: 5 }
        )
      return { from: match.from, options: [...mine, ...commandOptions], validFor: /^\\[A-Za-z@]*$/ }
    }
    return null
  }
}
