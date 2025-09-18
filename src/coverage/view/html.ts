import type {CoverageData, CoverageSummary, Line, FunctionStat} from "../data";
import {generateCoverageSummary, generateFunctionStats} from "../data";
import {MAIN_TEMPLATE, SUMMARY_TEMPLATE} from "./templates/templates";

interface TabInfo {
    readonly id: string;
    readonly filePath: string;
    readonly isActive: boolean;
    readonly content: string;
}

function generateFileContent(fileLines: readonly Line[], filePath: string, maxGas: number, totalGas: number): string {
    const htmlLines = fileLines
        .map((line, index) => generateLineHtml(line, index, maxGas, totalGas))
        .join("\n");

    return `<div class="file-content">
        <div class="code-container">
            <div class="file-header">${filePath}</div>
            ${htmlLines}
        </div>
    </div>`;
}

function generateFileSummaryTable(tabs: TabInfo[], coverage: CoverageData): string {
    const fileStats = tabs.map(tab => {
        const filePath = tab.filePath;
        const fileLines = coverage.lines.get(filePath) || [];
        const fileExecLines = coverage.executableLines?.get(filePath) || new Set();

        let coveredLines = 0;
        fileLines.forEach((line, index) => {
            const lineNumber = index + 1;
            if (fileExecLines.has(lineNumber) && line.info.$ === "Covered") {
                coveredLines++;
            }
        });

        const totalExecutableLines = fileExecLines.size;
        const coveragePercentage = totalExecutableLines === 0 ? 0 : (coveredLines / totalExecutableLines) * 100;

        return {
            filePath,
            coveredLines,
            totalLines: totalExecutableLines,
            coveragePercentage
        };
    });

    const tableRows = fileStats.map(stat => `
        <tr>
            <td><code>${stat.filePath.split('/').pop() || stat.filePath}</code></td>
            <td>${stat.coveredLines}</td>
            <td>${stat.totalLines}</td>
            <td>
                <div class="percent-container">
                    <div class="percent-text">${stat.coveragePercentage.toFixed(1)}%</div>
                    <div class="percent-bar">
                        <div class="percent-fill" style="width: ${stat.coveragePercentage}%"></div>
                    </div>
                </div>
            </td>
        </tr>
    `).join('');

    return `
        <div class="file-summary-container">
            <h3 style="margin: 0 0 15px 0; color: #333;">File Coverage Summary</h3>
            <table class="file-summary-table">
                <thead>
                    <tr>
                        <th>File</th>
                        <th>Covered Lines</th>
                        <th>Total Lines</th>
                        <th>Coverage</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>
    `;
}

function generateTabsHtml(tabs: TabInfo[], coverage: CoverageData): string {
    if (tabs.length === 1) {
        return tabs[0].content;
    }

    const summaryTable = generateFileSummaryTable(tabs, coverage);

    const tabButtons = tabs.map(tab => `
        <button class="tab-button ${tab.isActive ? 'active' : ''}" data-tab-id="${tab.id}" onclick="showTab('${tab.id}')">
            ${tab.filePath.split('/').pop() || tab.filePath}
        </button>
    `).join('');

    const tabContents = tabs.map(tab => `
        <div id="${tab.id}" class="tab-content ${tab.isActive ? 'active' : ''}">
            ${tab.content}
        </div>
    `).join('');

    return `
        <div class="tabs-container">
            ${summaryTable}
            <div class="tab-buttons">
                ${tabButtons}
            </div>
            <div class="tabs-content">
                ${tabContents}
            </div>
        </div>
    `;
}

const templates = {
    main: MAIN_TEMPLATE,
    summary: SUMMARY_TEMPLATE,
};

function renderTemplate(template: string, data: Record<string, unknown>): string {
    return template.replaceAll(/{{(\w+)}}/g, (_, key) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        return data[key]?.toString() ?? "";
    });
}

function formatGasCosts(gasCosts: readonly number[]): string {
    if (gasCosts.length === 0) return "";
    if (gasCosts.length === 1) return gasCosts[0]?.toString() ?? "0";

    const gasCount: Map<number, number> = new Map();
    for (const gas of gasCosts) {
        gasCount.set(gas, (gasCount.get(gas) ?? 0) + 1);
    }

    if (gasCount.size === 1) {
        const firstEntry = [...gasCount.entries()][0];
        return firstEntry?.[0]?.toString() ?? "";
    }

    return [...gasCount.entries()]
        .sort(([gas1], [gas2]) => gas1 - gas2)
        .map(([gas, count]) => `${gas} x${count}`)
        .join(", ");
}

function generateLineHtml(
    line: Line,
    index: number,
    maxGasPerLine: number,
    totalGas: number,
): string {
    const lineNumber = index + 1;
    const className = line.info.$;

    let gasHtml = `<div class="gas"></div>`;
    let hitsHtml = `<div class="hits"></div>`;
    let gasPercentStyle = "";

    if (line.info.$ === "Covered") {
        const gasInfo = line.info.gasCosts;
        const detailedGasCost = formatGasCosts(gasInfo);
        const totalGasCost = calculateTotalGas(gasInfo);

        const gasPercentage = Math.sqrt(totalGasCost / maxGasPerLine) * 100;
        const totalGasPercentage = totalGas === 0 ? 0 : (totalGasCost / totalGas) * 100;

        gasPercentStyle = ` style="--gas-percent:${gasPercentage.toFixed(4)}%" data-gas-percent="${totalGasPercentage.toFixed(2)}%"`;

        gasHtml = `<div class="gas">
            <span class="gas-detailed">${detailedGasCost}</span>
            <span class="gas-sum">${totalGasCost}</span>
        </div>`;
        hitsHtml = `<div class="hits" title="Number of times executed">${line.info.hits}</div>`;
    }

    return `<div class="line ${className}" id="L${lineNumber}"${gasPercentStyle} data-line-number="${lineNumber}">
    <div class="line-number">${lineNumber}</div>
    ${gasHtml}
    ${hitsHtml}
    <pre>${line.line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#039;")}</pre>
</div>`;
}

function calculateTotalGas(gasCosts: readonly number[]): number {
    return gasCosts.reduce((sum, gas) => sum + gas, 0);
}

function generateInstructionRowsHtml(summary: CoverageSummary): string {
    return summary.instructionStats
        .map(stat => {
            const percentValue = (stat.totalGas / summary.totalGas) * 100;
            return `<tr>
                <td data-value="${stat.name}"><code>${stat.name}</code></td>
                <td data-value="${stat.totalGas}">${stat.totalGas}</td>
                <td data-value="${stat.totalHits}">${stat.totalHits}</td>
                <td data-value="${stat.avgGas}">${stat.avgGas}</td>
                <td data-value="${percentValue}">
                    <div class="percent-container">
                        <div class="percent-text">${percentValue.toFixed(2)}%</div>
                        <div class="percent-bar">
                            <div class="percent-fill" style="width: ${percentValue}%"></div>
                        </div>
                    </div>
                </td>
            </tr>`;
        })
        .join("\n");
}

function generateFunctionRowsHtml(functionStats: readonly FunctionStat[], totalGas: number, totalInstructions: number): string {
    return functionStats
        .map(stat => {
            const gasPercentValue = (stat.totalGas / totalGas) * 100;
            const instructionsPercentValue = (stat.totalInstructions / totalInstructions) * 100;
            return `<tr>
                <td data-value="${stat.name}"><code>${stat.name}()</code></td>
                <td data-value="${stat.totalGas}">${stat.totalGas}</td>
                <td data-value="${stat.totalInstructions}">${stat.totalInstructions}</td>
                <td data-value="${gasPercentValue}">
                    <div class="percent-container">
                        <div class="percent-text">${gasPercentValue.toFixed(2)}%</div>
                        <div class="percent-bar">
                            <div class="percent-fill" style="width: ${gasPercentValue}%"></div>
                        </div>
                    </div>
                </td>
                <td data-value="${instructionsPercentValue}">
                    <div class="percent-container">
                        <div class="percent-text">${instructionsPercentValue.toFixed(2)}%</div>
                        <div class="percent-bar">
                            <div class="percent-fill" style="width: ${instructionsPercentValue}%"></div>
                        </div>
                    </div>
                </td>
            </tr>`;
        })
        .join("\n");
}

export function generateHtmlReport(coverage: CoverageData): string {
    const summary = generateCoverageSummary(coverage);
    const functionStats = generateFunctionStats(coverage);

    // Calculate max gas across all files
    let maxGas = 0;
    for (const [filePath, fileLines] of coverage.lines) {
        for (const line of fileLines) {
            if (line.info.$ === "Covered") {
                const lineGas = line.info.gasCosts.reduce((sum, gas) => sum + gas, 0);
                maxGas = Math.max(maxGas, lineGas);
            }
        }
    }

    const tabs = Array.from(coverage.lines.entries())
        .filter(([filePath]) => {
            const fileExecLines = coverage.executableLines?.get(filePath);
            return fileExecLines && fileExecLines.size > 0;
        })
        .map(([filePath, fileLines], index) => ({
            id: `tab-${index}`,
            filePath,
            isActive: index === 0,
            content: generateFileContent(fileLines, filePath, maxGas, summary.totalGas)
        }));

    const tabsHtml = generateTabsHtml(tabs, coverage);

    const totalFunctionInstructions = functionStats.reduce((sum, stat) => sum + stat.totalInstructions, 0);

    const templateData = {
        coverage_percentage: summary.coveragePercentage.toFixed(2),
        covered_lines: summary.coveredLines,
        total_lines: summary.totalLines,
        total_gas: summary.totalGas,
        total_hits: functionStats.length > 0 ? functionStats.length : summary.totalHits,
        instruction_rows: functionStats.length > 0 ? generateFunctionRowsHtml(functionStats, summary.totalGas, totalFunctionInstructions) : generateInstructionRowsHtml(summary),
        stats_type: functionStats.length > 0 ? "Function Statistics" : "Instruction Statistics",
        stats_label: functionStats.length > 0 ? "Functions Executed" : "Instructions Executed",
        stats_headers: functionStats.length > 0 ?
            `<th class="sortable" data-column="name">
                Function <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="gas">
                Total Gas <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="instructions">
                Instructions <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="gasPercent">
                % Gas <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="instructionsPercent">
                % Instructions <span class="sort-icon">↕</span>
            </th>` :
            `<th class="sortable" data-column="name">
                Instruction <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="gas">
                Total Gas <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="hits">
                Hits <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="avgGas">
                Avg Gas <span class="sort-icon">↕</span>
            </th>
            <th class="sortable" data-column="percent">
                % of Total Gas <span class="sort-icon">↕</span>
            </th>`,
    };

    const summaryHtml = renderTemplate(templates.summary, templateData);

    return renderTemplate(templates.main, {
        SUMMARY_CONTENT: summaryHtml,
        CODE_CONTENT: tabsHtml,
    });
}
