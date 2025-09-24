import type {CoverageData, Line} from "../data";
import {generateCoverageSummary} from "../data";

export interface TolkHtmlOutput {
    readonly files: Map<string, string>; // file path -> HTML content
    readonly folders: Map<string, string>; // folder path -> HTML content
    readonly index: string; // root index.html
}

export function generateTolkHtmlReport(coverage: CoverageData): TolkHtmlOutput {
    const files = new Map<string, string>();
    const folders = new Map<string, string>();
    const folderStats = new Map<string, FolderStats>();

    for (const [filePath, fileLines] of coverage.lines) {
        const fileHtml = generateFileHtml(filePath, fileLines, coverage);
        files.set(filePath, fileHtml);

        const folderPath = getFolderPath(filePath);
        if (!folderStats.has(folderPath)) {
            folderStats.set(folderPath, {
                files: [],
                totalLines: 0,
                coveredLines: 0,
                coveragePercentage: 0
            });
        }

        const fileStats = calculateFileStats(fileLines, coverage, filePath);
        const folderStat = folderStats.get(folderPath)!;
        folderStat.files.push({
            name: getFileName(filePath),
            path: filePath,
            ...fileStats
        });
        folderStat.totalLines += fileStats.totalLines;
        folderStat.coveredLines += fileStats.coveredLines;
    }

    for (const folderStat of folderStats.values()) {
        folderStat.coveragePercentage = folderStat.totalLines === 0 ? 0 :
            (folderStat.coveredLines / folderStat.totalLines) * 100;
    }

    for (const [folderPath, stats] of folderStats) {
        const folderHtml = generateFolderHtml(folderPath, stats, coverage);
        folders.set(folderPath, folderHtml);
    }

    const indexHtml = generateIndexHtml(folderStats, coverage);

    return {
        files,
        folders,
        index: indexHtml
    };
}

function getFolderPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.slice(0, -1).join('/') || '/';
}

function getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1];
}

interface FileStats {
    readonly totalLines: number;
    readonly coveredLines: number;
    readonly coveragePercentage: number;
}

interface FolderStats {
    files: Array<FileStats & { name: string; path: string }>;
    totalLines: number;
    coveredLines: number;
    coveragePercentage: number;
}

function calculateFileStats(fileLines: readonly Line[], coverage: CoverageData, filePath: string): FileStats {
    const fileExecLines = coverage.executableLines?.get(filePath) || new Set();
    let coveredLines = 0;
    let totalLines = 0;

    fileLines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (fileExecLines.has(lineNumber)) {
            totalLines++;
            if (line.info.$ === "Covered") {
                coveredLines++;
            }
        }
    });

    const coveragePercentage = totalLines === 0 ? 0 : (coveredLines / totalLines) * 100;

    return {
        totalLines,
        coveredLines,
        coveragePercentage
    };
}

function generateFileHtml(filePath: string, fileLines: readonly Line[], coverage: CoverageData): string {
    let coveredLines = 0;
    let totalLines = 0;

    let totalFunctions = 0;
    const functionLines = new Set<number>();

    for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i];
        if (line.line.trim().startsWith('fun ')) {
            totalFunctions++;
            functionLines.add(i);
        }

        if (line.info.$ === "Covered") {
            coveredLines++;
            totalLines++;
        } else if (line.info.$ === "Uncovered") {
            totalLines++;
        }
    }

    let coveredFunctions = 0;
    const fileFunctionNames = new Set<string>();

    for (const lineIndex of functionLines) {
        const line = fileLines[lineIndex];
        const funMatch = line.line.trim().match(/^fun\s+([^\(\s]+)/);
        if (funMatch) {
            // Handle method syntax like "Foo.create" or simple function names
            const fullFunctionName = funMatch[1];
            fileFunctionNames.add(fullFunctionName);
        }
    }

    if (coverage.gasPerFunction) {
        for (const [executedFunctionName] of coverage.gasPerFunction) {
            if (fileFunctionNames.has(executedFunctionName)) {
                coveredFunctions++;
            }
        }
    }

    const coveragePercentage = totalLines === 0 ? 0 : (coveredLines / totalLines) * 100;
    const functionCoveragePercentage = totalFunctions === 0 ? 0 : (coveredFunctions / totalFunctions) * 100;

    const linesHtml = fileLines.map((line, index) => generateLineHtml(line, index)).join('\n');

    const fileName = getFileName(filePath);
    const folderPath = getFolderPath(filePath);
    const backLink = folderPath === '/' ? './index.html' : `./${folderPath}/index.html`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fileName} - Coverage Report</title>
    <style>
        :root {
            /* Light theme colors */
            --bg-color: #ffffff;
            --text-color: #24292f;
            --link-color: #0078d7;
            --line-number-color: #888;
            --line-bg: #f8f8f8;
            --line-hits-color: #666;
            --hits-covered-bg: #ddffdd;
            --hits-zero-color: #cf222e;
            --hits-partial-bg: #fff3cd;
            --uncovered-bg: #ffe6e6;
            --token-keyword: #cf222e;
            --token-entity: #6639ba;
            --token-string: #0a3069;
            --token-number: #0550ae;
            --token-comment: #59636e;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* Dark theme colors */
                --bg-color: #0d1117;
                --text-color: #c9d1d9;
                --link-color: #79c0ff;
                --line-number-color: #7d8590;
                --line-bg: #161b22;
                --line-hits-color: #fff;
                --hits-covered-bg: #238636;
                --hits-zero-color: #f85149;
                --hits-partial-bg: transparent;
                --uncovered-bg: #490e0e;
                --token-keyword: #ff7b72;
                --token-entity: #d2a8ff;
                --token-string: #a5d6ff;
                --token-number: #79c0ff;
                --token-comment: #8b949e;
            }
        }

        body {
            font-family: monospace; margin: 0; padding: 5px;
            background-color: var(--bg-color);
            color: var(--text-color);
        }
        .header { margin-bottom: 10px; }
        .file-stats { margin-top: 10px; }
        .file-stats .stat { display: inline-block; margin-right: 20px; }
        .back-link { margin-bottom: 10px; }
        .back-link a {
            color: var(--link-color);
            text-decoration: none;
        }
        .back-link a:hover { text-decoration: underline; }
        .line { display: flex; margin: 0; line-height: 1; }
        .line.partial-coverage { background-color: var(--hits-partial-bg); }
        .line-number {
            width: 40px;
            text-align: right;
            color: var(--line-number-color);
            padding: 4px 8px 0 3px;
            background: var(--line-bg);
            user-select: none;
        }
        .line-hits {
            width: 30px;
            text-align: center;
            color: var(--line-hits-color);
            padding: 4px 1px 0;
            background: var(--line-bg);
            user-select: none;
            font-family: monospace;
            font-size: 0.8rem;
        }
        .line-hits.hits-covered { background: var(--hits-covered-bg); }
        .line-hits.hits-zero { color: var(--hits-zero-color); }
        .line-hits.hits-partial { background: var(--hits-partial-bg); }
        .line-content { flex: 1; padding: 0 10px; line-height: 1.6; white-space: pre; user-select: text; }
        .covered { display: block; }
        .uncovered { background-color: var(--uncovered-bg); display: block; }
        .line-content .skipped { opacity: 0.4; }
        .line-content .skipped > .token-type { font-weight: normal; }

        /* Precise coverage highlighting */
        .covered-part { /* Normal background */ }
        .uncovered-part { background-color: var(--uncovered-bg); }

        /* Syntax highlighting (GitHub official theme colors) */
        .token-keyword { color: var(--token-keyword); }
        .token-type { font-weight: bold; }
        .token-entity { color: var(--token-entity); }
        .token-string { color: var(--token-string); }
        .token-number { color: var(--token-number); }
        .token-comment { color: var(--token-comment); font-style: italic; }
    </style>
</head>
<body>
    <div class="header">
        <div class="back-link"><a href="${backLink}">← Back to ${folderPath === '/' ? 'root' : folderPath}</a></div>
        <h1>${fileName}</h1>
        <p>File: ${filePath}</p>
        <div class="file-stats">
            <div class="stat"><strong>Coverage:</strong> ${coveragePercentage.toFixed(1)}%</div>
            <div class="stat"><strong>Lines:</strong> ${coveredLines}/${totalLines}</div>
            <div class="stat"><strong>Functions:</strong> ${coveredFunctions}/${totalFunctions} (${functionCoveragePercentage.toFixed(1)}%)</div>
        </div>
    </div>
    <div class="code">
        ${linesHtml}
    </div>
</body>
</html>`;
}

const TOLK_KEYWORDS = [
    "tolk", "import", "global", "const", "type", "struct", "fun", "get", "var", "val",
    "return", "if", "else", "while", "repeat", "do", "break", "continue", "throw",
    "assert", "try", "catch", "match", "as", "is", "lazy", "mutate", "redef",
    "builtin", "asm", "true", "false", "null", "self"
];

const TOLK_TYPE_KEYWORDS = [
    "int", "bool", "cell", "slice", "builder", "continuation", "tuple", "address",
    "never", "coins", "map", "void"
];

type TokenType = 'keyword' | 'type' | 'entity' | 'string' | 'number' | 'comment' | 'text';

interface Token {
    type: TokenType;
    value: string;
}

export function tokenizeTolkCode(code: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < code.length) {
        const char = code[i];

        if (/\s/.test(char)) {
            let text = '';
            while (i < code.length && /\s/.test(code[i])) {
                text += code[i];
                i++;
            }
            tokens.push({ type: 'text', value: text });
            continue;
        }

        // Comments
        if (char === '/' && i + 1 < code.length) {
            if (code[i + 1] === '/') {
                // Single line comment
                let comment = '';
                while (i < code.length && code[i] !== '\n') {
                    comment += code[i];
                    i++;
                }
                tokens.push({ type: 'comment', value: comment });
                continue;
            } else if (code[i + 1] === '*') {
                // Multi-line comment
                let comment = '';
                i += 2; // Skip /*
                while (i + 1 < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
                    comment += code[i];
                    i++;
                }
                if (i + 1 < code.length) {
                    comment += '*/';
                    i += 2;
                }
                tokens.push({ type: 'comment', value: '/*' + comment });
                continue;
            }
        }

        if (char === '"' || char === "'") {
            const quote = char;
            let str = char;
            i++;
            while (i < code.length && code[i] !== quote) {
                if (code[i] === '\\' && i + 1 < code.length) {
                    str += code[i] + code[i + 1];
                    i += 2;
                } else {
                    str += code[i];
                    i++;
                }
            }
            if (i < code.length) {
                str += code[i];
                i++;
            }
            tokens.push({ type: 'string', value: str });
            continue;
        }

        if (/\d/.test(char) || (char === '0' && i + 1 < code.length && /[xXbBoO]/.test(code[i + 1]))) {
            let num = '';

            if (char === '0' && i + 1 < code.length && /[xXbBoO]/.test(code[i + 1])) {
                num += char; // '0'
                i++;
                num += code[i]; // 'x', 'X', 'b', 'B', 'o', 'O'
                i++;

                // Read the rest based on the prefix
                if (/[xX]/.test(num.slice(-1))) {
                    // Hexadecimal
                    while (i < code.length && /[0-9a-fA-F_]/.test(code[i])) {
                        num += code[i];
                        i++;
                    }
                } else if (/[bB]/.test(num.slice(-1))) {
                    // Binary
                    while (i < code.length && /[01_]/.test(code[i])) {
                        num += code[i];
                        i++;
                    }
                } else if (/[oO]/.test(num.slice(-1))) {
                    // Octal
                    while (i < code.length && /[0-7_]/.test(code[i])) {
                        num += code[i];
                        i++;
                    }
                }
            } else {
                // Regular decimal number
                while (i < code.length && /[\d._]/.test(code[i])) {
                    num += code[i];
                    i++;
                }
            }

            tokens.push({ type: 'number', value: num });
            continue;
        }

        if (/[a-zA-Z_]/.test(char)) {
            let identifier = '';
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) {
                identifier += code[i];
                i++;
            }

            if (TOLK_TYPE_KEYWORDS.includes(identifier)) {
                tokens.push({ type: 'type', value: identifier });
            }
            else if (TOLK_KEYWORDS.includes(identifier)) {
                tokens.push({ type: 'keyword', value: identifier });
            }
            else if (/^[A-Z]/.test(identifier)) {
                tokens.push({ type: 'entity', value: identifier });
            }
            else {
                tokens.push({ type: 'text', value: identifier });
            }
            continue;
        }

        tokens.push({ type: 'text', value: char });
        i++;
    }

    return tokens;
}

function syntaxHighlight(code: string): string {
    const tokens = tokenizeTolkCode(code);
    let highlighted = '';

    for (const token of tokens) {
        let escapedValue = token.value.replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char] || char));

        switch (token.type) {
            case 'keyword':
                highlighted += `<span class="token-keyword">${escapedValue}</span>`;
                break;
            case 'type':
                highlighted += `<span class="token-type">${escapedValue}</span>`;
                break;
            case 'entity':
                highlighted += `<span class="token-entity">${escapedValue}</span>`;
                break;
            case 'string':
                highlighted += `<span class="token-string">${escapedValue}</span>`;
                break;
            case 'number':
                highlighted += `<span class="token-number">${escapedValue}</span>`;
                break;
            case 'comment':
                highlighted += `<span class="token-comment">${escapedValue}</span>`;
                break;
            default:
                highlighted += escapedValue;
        }
    }

    return highlighted;
}

function generatePreciseHighlightedCode(line: Line): string {
    const sourceLine = line.line;
    const instructions = (line.info.$ === 'Covered' || line.info.$ === 'Uncovered') ? line.info.instructions : undefined;

    if (!instructions || instructions.length === 0) {
        const highlighted = syntaxHighlight(sourceLine);
        const className = line.info.$ === 'Covered' ? 'covered' :
                         line.info.$ === 'Uncovered' ? 'uncovered' :
                         line.info.$ === 'Skipped' ? 'skipped' : '';
        return `<span class="${className}">${highlighted}</span>`;
    }

    const allExecuted = instructions.every(inst => inst.executed);
    const noneExecuted = instructions.every(inst => !inst.executed);

    if (allExecuted) {
        const highlighted = syntaxHighlight(sourceLine);
        return `<span class="covered">${highlighted}</span>`;
    }

    if (noneExecuted) {
        const highlighted = syntaxHighlight(sourceLine);
        return `<span class="uncovered">${highlighted}</span>`;
    }

    const unexecutedInstructions = instructions.filter(inst => !inst.executed);
    
    const sortedUnexecuted = [...unexecutedInstructions].sort((a, b) => a.column - b.column);
    
    const mergedRanges: { start: number; end: number }[] = [];
    for (const instruction of sortedUnexecuted) {
        const start = instruction.column;
        const end = Math.min(instruction.column + Math.max(instruction.length, 5), sourceLine.length);
        
        const last = mergedRanges[mergedRanges.length - 1];
        if (last && last.end >= start) {
            last.end = Math.max(last.end, end);
        } else {
            mergedRanges.push({ start, end });
        }
    }
    
    let result = '';
    let lastEnd = 0;

    for (const range of mergedRanges) {
        if (range.start > lastEnd) {
            const coveredPart = sourceLine.slice(lastEnd, range.start);
            if (coveredPart) {
                const highlighted = syntaxHighlight(coveredPart);
                result += highlighted;
            }
        }

        const uncoveredPart = sourceLine.slice(range.start, range.end);
        if (uncoveredPart) {
            const highlighted = syntaxHighlight(uncoveredPart);
            result += `<span class="uncovered-part">${highlighted}</span>`;
        }

        lastEnd = range.end;
    }

    if (lastEnd < sourceLine.length) {
        const coveredPart = sourceLine.slice(lastEnd);
        if (coveredPart) {
            const highlighted = syntaxHighlight(coveredPart);
            result += highlighted;
        }
    }

    return result;
}

function generateLineHtml(line: Line, index: number): string {
    const lineNumber = index + 1;

    const hits = line.info.$ === 'Covered' ? 1 : 0;

    let hitsClass = '';
    let lineClass = '';
    const instructions = (line.info.$ === 'Covered' || line.info.$ === 'Uncovered') ? line.info.instructions : undefined;

    if (instructions && instructions.length > 0) {
        const hasExecuted = instructions.some(inst => inst.executed);
        const hasUnexecuted = instructions.some(inst => !inst.executed);

        if (hasExecuted && hasUnexecuted) {
            hitsClass = 'hits-partial';
            lineClass = 'partial-coverage';
        } else if (hasExecuted) {
            hitsClass = 'hits-covered';
        } else {
            hitsClass = 'hits-zero';
        }
    } else {
        hitsClass = line.info.$ === 'Covered' ? 'hits-covered' :
                   line.info.$ === 'Uncovered' ? 'hits-zero' : '';
    }

    const hitsDisplay = line.info.$ === 'Skipped' ? '' : hits.toString() + 'x';

    const highlightedCode = generatePreciseHighlightedCode(line);

    return `<div class="line ${lineClass}">
        <div class="line-number">${lineNumber}</div>
        <div class="line-hits ${hitsClass}">${hitsDisplay}</div>
        <div class="line-content">${highlightedCode}</div>
    </div>`;
}

function generateFolderHtml(folderPath: string, stats: FolderStats, coverage: CoverageData): string {
    const folderName = folderPath === '/' ? 'Root' : getFileName(folderPath);
    const backLink = folderPath === '/' ? '' : getParentBackLink(folderPath);

    const filesTable = stats.files.map(file => `
        <tr>
            <td><a href="../${file.path}.html">${file.name}</a></td>
            <td>${file.coveredLines}/${file.totalLines}</td>
            <td>${file.coveragePercentage.toFixed(1)}%</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${folderName} - Coverage Report</title>
    <style>
        :root {
            /* Light theme colors */
            --bg-color: #ffffff;
            --text-color: #24292f;
            --link-color: #0078d7;
            --border-color: #ddd;
            --header-bg: #f8f8f8;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* Dark theme colors */
                --bg-color: #0d1117;
                --text-color: #f0f6fc;
                --link-color: #79c0ff;
                --border-color: #30363d;
                --header-bg: #161b22;
            }
        }

        body {
            font-family: system-ui, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: var(--bg-color);
            color: var(--text-color);
        }
        .header { margin-bottom: 20px; }
        .back-link { margin-bottom: 10px; }
        .back-link a {
            color: var(--link-color);
            text-decoration: none;
        }
        .back-link a:hover { text-decoration: underline; }
        table { border-collapse: collapse; width: 100%; margin-top: 20px; }
        th, td {
            border: 1px solid var(--border-color);
            padding: 8px 12px;
            text-align: left;
        }
        th { background-color: var(--header-bg); }
        a {
            color: var(--link-color);
            text-decoration: none;
        }
        a:hover { text-decoration: underline; }
        .stats { margin-bottom: 20px; }
        .stat { display: inline-block; margin-right: 20px; }
    </style>
</head>
<body>
    <div class="header">
        ${backLink ? `<div class="back-link"><a href="${backLink}">← Back</a></div>` : ''}
        <h1>${folderName}</h1>
        <p>Path: ${folderPath}</p>
    </div>

    <div class="stats">
        <div class="stat"><strong>Total Lines:</strong> ${stats.totalLines}</div>
        <div class="stat"><strong>Covered Lines:</strong> ${stats.coveredLines}</div>
        <div class="stat"><strong>Coverage:</strong> ${stats.coveragePercentage.toFixed(1)}%</div>
    </div>

    <h2>Files in this folder</h2>
    <table>
        <thead>
            <tr>
                <th>File</th>
                <th>Coverage</th>
                <th>Percentage</th>
            </tr>
        </thead>
        <tbody>
            ${filesTable}
        </tbody>
    </table>
</body>
</html>`;
}

function getParentBackLink(folderPath: string): string {
    const parts = folderPath.split('/').filter(p => p);
    if (parts.length <= 1) {
        return './index.html';
    }
    const parentPath = parts.slice(0, -1).join('/');
    return `../${parentPath}/index.html`;
}

function generateIndexHtml(folderStats: Map<string, FolderStats>, coverage: CoverageData): string {
    const summary = generateCoverageSummary(coverage);

    const foldersTable = Array.from(folderStats.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([folderPath, stats]) => {
            const folderName = folderPath === '/' ? 'Root' : getFileName(folderPath);
            const linkPath = folderPath === '/' ? './root/index.html' : `./${folderPath}/index.html`;
            return `
        <tr>
            <td><a href="${linkPath}">${folderName}</a></td>
            <td>${stats.files.length}</td>
            <td>${stats.coveredLines}/${stats.totalLines}</td>
            <td>${stats.coveragePercentage.toFixed(1)}%</td>
        </tr>
    `}).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tolk Coverage Report</title>
    <style>
        :root {
            /* Light theme colors */
            --bg-color: #ffffff;
            --text-color: #24292f;
            --link-color: #0078d7;
            --border-color: #ddd;
            --header-bg: #f8f8f8;
            --summary-bg: #f8f8f8;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* Dark theme colors */
                --bg-color: #0d1117;
                --text-color: #f0f6fc;
                --link-color: #79c0ff;
                --border-color: #30363d;
                --header-bg: #161b22;
                --summary-bg: #161b22;
            }
        }

        body {
            font-family: system-ui, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: var(--bg-color);
            color: var(--text-color);
        }
        .header { margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; margin-top: 20px; }
        th, td {
            border: 1px solid var(--border-color);
            padding: 8px 12px;
            text-align: left;
        }
        th { background-color: var(--header-bg); }
        a {
            color: var(--link-color);
            text-decoration: none;
        }
        a:hover { text-decoration: underline; }
        .stats { margin-bottom: 20px; }
        .stat { display: inline-block; margin-right: 20px; font-size: 18px; }
        .summary {
            background-color: var(--summary-bg);
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Tolk Coverage Report</h1>
    </div>

    <div class="summary">
        <div class="stats">
            <div class="stat"><strong>Total Coverage:</strong> ${summary.coveragePercentage.toFixed(1)}%</div>
            <div class="stat"><strong>Covered Lines:</strong> ${summary.coveredLines}/${summary.totalLines}</div>
            <div class="stat"><strong>Total Gas:</strong> ${summary.totalGas}</div>
        </div>
    </div>

    <h2>Folders</h2>
    <table>
        <thead>
            <tr>
                <th>Folder</th>
                <th>Files</th>
                <th>Coverage</th>
                <th>Percentage</th>
            </tr>
        </thead>
        <tbody>
            ${foldersTable}
        </tbody>
    </table>
</body>
</html>`;
}
