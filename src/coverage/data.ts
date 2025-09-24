import type { trace } from "ton-assembly";
import { Cell } from "@ton/core";
import { HighLevelMapping } from "ton-source-map";

export type CoverageData = {
    readonly code: Cell;
    readonly lines: Map<string, readonly Line[]>;
    readonly gasPerFunction?: Map<string, { gas: number; instructions: number }>;
    readonly executableLines?: Map<string, Set<number>>;
};

export type Line = {
    readonly line: string
    readonly info: Covered | Uncovered | Skipped
}

export type Covered = {
    readonly $: "Covered"
    readonly hits: number
    readonly gasCosts: readonly number[]
    readonly instructions?: readonly InstructionCoverage[]
}

export type Uncovered = {
    readonly $: "Uncovered"
    readonly instructions?: readonly InstructionCoverage[]
}

export type Skipped = {
    readonly $: "Skipped"
}

export type InstructionCoverage = {
    readonly column: number
    readonly length: number
    readonly executed: boolean
}

export type InstructionStat = {
    readonly name: string
    readonly totalGas: number
    readonly totalHits: number
    readonly avgGas: number
}

export type FunctionStat = {
    readonly name: string
    readonly totalGas: number
    readonly totalInstructions: number
}

export type CoverageSummary = {
    readonly totalLines: number
    readonly coveredLines: number
    readonly uncoveredLines: number
    readonly coveragePercentage: number
    readonly totalGas: number
    readonly totalHits: number
    readonly instructionStats: readonly InstructionStat[]
}

export function buildLineInfo(trace: trace.TraceInfo, asm: string): readonly Line[] {
    const lines = asm.split("\n");

    const perLineSteps: Map<number, trace.Step[]> = new Map();

    for (const step of trace.steps) {
        if (step.loc === undefined) continue;
        const line = step.loc.line;

        perLineSteps.set(line + 1, [...(perLineSteps.get(line + 1) ?? []), step]);

        if (step.loc.otherLines.length > 0) {
            for (const otherLine of step.loc.otherLines) {
                perLineSteps.set(otherLine + 1, [...(perLineSteps.get(otherLine + 1) ?? []), step]);
            }
        }
    }

    return lines.map((line, idx): Line => {
        const info = perLineSteps.get(idx + 1);
        if (info) {
            const gasInfo = info.map(step => normalizeGas(step.gasCost));

            return {
                line,
                info: {
                    $: "Covered",
                    hits: gasInfo.length,
                    gasCosts: gasInfo,
                },
            };
        }

        if (!isExecutableLine(line)) {
            return {
                line,
                info: {
                    $: "Skipped",
                },
            };
        }

        return {
            line,
            info: {
                $: "Uncovered",
            },
        };
    });
}

type StepWithGas = { step: trace.Step, countGas: boolean };
export const buildTolkLineInfo = (trace: trace.TraceInfo, sourceMap?: HighLevelMapping): {
    lines: Map<string, Line[]>,
    gasPerFunction: Map<string, { gas: number; instructions: number }>,
    executableLines: Map<string, Set<number>>
} => {
    const lines = new Map<string, Line[]>();
    const executableLines = new Map<string, Set<number>>();

    if (sourceMap?.files) {
        for (const file of sourceMap.files) {
            if (!file.is_stdlib) { // Skip stdlib files
                const fileLines = file.content.split("\n");
                lines.set(file.path, fileLines.map(line => ({
                    line,
                    info: {$: "Skipped"} as Skipped,
                })));
                executableLines.set(file.path, new Set());
            }
        }
    }

    sourceMap?.locations.forEach(location => {
        const fileExecLines = executableLines.get(location.loc.file) ?? new Set();
        fileExecLines.add(location.loc.line);
        executableLines.set(location.loc.file, fileExecLines);
    });

    const perLineSteps: Map<string, Map<number, StepWithGas[]>> = new Map();
    const perLineInstructions: Map<string, Map<number, InstructionCoverage[]>> = new Map();
    const stepsPerFunction: Map<string, trace.Step[]> = new Map();
    const executedSteps = new Set<trace.Step>();

    for (const step of trace.steps) {
        executedSteps.add(step);
        
        if (step.sourceMapEntries.length === 0) {
            continue;
        }

        let stepIsCounted = false;
        for (const entry of step.sourceMapEntries) {
            const filePath = entry.loc.file;
            const line = (entry.loc.line ?? 0);

            if (!perLineSteps.has(filePath)) {
                perLineSteps.set(filePath, new Map());
            }
            const fileSteps = perLineSteps.get(filePath)!;

            if (fileSteps.get(line)?.at(-1)?.step !== step) {
                fileSteps.set(line, [...(fileSteps.get(line) ?? []), {step, countGas: true}]);
                // stepIsCounted = entry.ast_kind !== "ast_function_declaration";
            }

            const inlinedTo = entry.context.inlining.inlined_to_func;
            if (inlinedTo !== undefined) {
                // inlined
                if (stepsPerFunction.get(inlinedTo)?.at(-1) !== step) {
                    stepsPerFunction.set(inlinedTo, [...(stepsPerFunction.get(inlinedTo) ?? []), step]);
                }
                continue;
            }
            const containingFunction = entry.context.containing_function;
            if (stepsPerFunction.get(containingFunction)?.at(-1) !== step) {
                stepsPerFunction.set(containingFunction, [...(stepsPerFunction.get(containingFunction) ?? []), step]);
            }
        }
    }

    sourceMap?.locations.forEach(location => {
        const filePath = location.loc.file;
        const line = location.loc.line;
        const column = location.loc.column;
        const length = location.loc.length;

        if (!perLineInstructions.has(filePath)) {
            perLineInstructions.set(filePath, new Map());
        }
        const fileInstructions = perLineInstructions.get(filePath)!;

        let executed = false;
        for (const step of trace.steps) {
            for (const entry of step.sourceMapEntries) {
                if (entry.loc.file === filePath && 
                    entry.loc.line === line && 
                    entry.loc.column === column && 
                    entry.loc.length === length) {
                    executed = true;
                    break;
                }
            }
            if (executed) break;
        }

        const instruction: InstructionCoverage = {
            column,
            length,
            executed
        };

        const lineInstructions = fileInstructions.get(line) ?? [];
        if (!lineInstructions.some(inst => inst.column === column && inst.length === length)) {
            fileInstructions.set(line, [...lineInstructions, instruction]);
        }
    });

    const gasPerFunction = new Map(stepsPerFunction.entries().map(([func, steps]) => {
        const gas = steps.flatMap(step => normalizeGas(step.gasCost)).reduce((acc, gas) => acc + gas, 0);
        const instructions = steps.length;
        return [func, {gas, instructions}];
    }));

    const resultLines = new Map<string, Line[]>();

    for (const [filePath, fileLines] of lines) {
        const fileSteps = perLineSteps.get(filePath) ?? new Map<number, StepWithGas[]>();
        const fileInstructions = perLineInstructions.get(filePath) ?? new Map<number, InstructionCoverage[]>();
        const fileExecLines = executableLines.get(filePath) ?? new Set();

        const processedLines = fileLines.map((lineObj, lineNumber): Line => {
            const infos = fileSteps.get(lineNumber);
            const instructions = fileInstructions.get(lineNumber) ?? [];

            if (infos) {
                const gasValues = infos.flatMap(step => {
                    if (!step.countGas) {
                        return [];
                    }
                    return normalizeGas(step.step.gasCost);
                });

                return {
                    line: lineObj.line,
                    info: {
                        $: "Covered",
                        hits: gasValues.length,
                        gasCosts: gasValues,
                        instructions: instructions.length > 0 ? instructions : undefined,
                    } as Covered,
                };
            }

            if (!isExecutableLine(lineObj.line) || !fileExecLines.has(lineNumber)) {
                return {
                    line: lineObj.line,
                    info: {
                        $: "Skipped",
                    },
                };
            }

            return {
                line: lineObj.line,
                info: {
                    $: "Uncovered",
                    instructions: instructions.length > 0 ? instructions : undefined,
                },
            };
        });

        resultLines.set(filePath, processedLines);
    }

    return {lines: resultLines, gasPerFunction, executableLines};
};

function normalizeGas(gas: number): number {
    if (gas > 10000) {
        // Normalize first SETCP to normal value
        return 26;
    }
    return gas;
}

export function isExecutableLine(line: string): boolean {
    const trimmed = line.trim();
    return (
        !trimmed.includes("=>") && // dictionary
        trimmed !== "}" && // close braces
        trimmed !== "]" && // close bracket
        trimmed.length > 0
    );
}

export function generateCoverageSummary(coverage: CoverageData): CoverageSummary {
    let totalExecutableLines = 0;
    let coveredLines = 0;

    for (const [filePath, fileLines] of coverage.lines) {
        const fileExecLines = coverage.executableLines?.get(filePath) || new Set();

        for (const [lineNumber, line] of fileLines.entries()) {
            const isLineExecutable = coverage.executableLines
                ? fileExecLines.has(lineNumber)
                : isExecutableLine(line.line);

            if (isLineExecutable) {
                totalExecutableLines++;
                if (line.info.$ === "Covered") {
                    coveredLines++;
                }
            }
        }
    }

    const uncoveredLines = totalExecutableLines - coveredLines;
    const coveragePercentage = totalExecutableLines === 0 ? 0 : (coveredLines / totalExecutableLines) * 100;

    let totalGas = 0;
    let totalHits = 0;

    const instructionMap: Map<string, { readonly totalGas: number; readonly hits: number }> =
        new Map();

    for (const [, fileLines] of coverage.lines) {
        for (const line of fileLines) {
            if (line.info.$ !== "Covered") continue;

            const lineGas = line.info.gasCosts.reduce((sum, gas) => sum + gas, 0);
            totalGas += lineGas;
            totalHits += line.info.hits;
            const trimmedLine = line.line.trim();
            const instructionName = trimmedLine.split(/\s+/)[0];
            if (instructionName !== undefined) {
                const current = instructionMap.get(instructionName) ?? {totalGas: 0, hits: 0};
                instructionMap.set(instructionName, {
                    totalGas: current.totalGas + lineGas,
                    hits: current.hits + line.info.hits,
                });
            }
        }
    }

    const instructionStats: InstructionStat[] = [...instructionMap.entries()]
        .map(([name, stats]) => ({
            name,
            totalGas: stats.totalGas,
            totalHits: stats.hits,
            avgGas: stats.hits === 0 ? 0 : Math.round((stats.totalGas / stats.hits) * 100) / 100,
        }))
        .sort((a, b) => b.totalGas - a.totalGas);

    return {
        totalLines: totalExecutableLines,
        coveredLines,
        uncoveredLines,
        coveragePercentage,
        totalGas,
        totalHits,
        instructionStats,
    };
}

export function generateFunctionStats(coverage: CoverageData): FunctionStat[] {
    if (!coverage.gasPerFunction) {
        return [];
    }

    return [...coverage.gasPerFunction.entries()]
        .map(([name, stats]) => ({
            name,
            totalGas: stats.gas,
            totalInstructions: stats.instructions,
        }))
        .sort((a, b) => b.totalGas - a.totalGas);
}

export function mergeCoverages(...coverages: readonly CoverageData[]): CoverageData {
    if (coverages.length === 0) {
        return {
            code: new Cell(),
            lines: new Map(),
        };
    }

    if (coverages.length === 1) {
        return coverages[0];
    }

    const allFilePaths = new Set<string>();
    coverages.forEach(coverage => {
        coverage.lines.forEach((_, filePath) => allFilePaths.add(filePath));
    });

    const mergedLines = new Map<string, readonly Line[]>();
    for (const filePath of allFilePaths) {
        let mergedFileLines: readonly Line[] | undefined;

        coverages.forEach(coverage => {
            const fileLines = coverage.lines.get(filePath);
            if (fileLines) {
                if (mergedFileLines === undefined) {
                    mergedFileLines = fileLines;
                } else {
                    mergedFileLines = mergeTwoLines(mergedFileLines, fileLines);
                }
            }
        });

        if (mergedFileLines) {
            mergedLines.set(filePath, mergedFileLines);
        }
    }

    const mergedGasPerFunction = new Map<string, { gas: number; instructions: number }>();
    coverages.forEach(coverage => {
        if (coverage.gasPerFunction) {
            coverage.gasPerFunction.forEach((stats, funcName) => {
                const existing = mergedGasPerFunction.get(funcName);
                if (existing) {
                    mergedGasPerFunction.set(funcName, {
                        gas: existing.gas + stats.gas,
                        instructions: existing.instructions + stats.instructions,
                    });
                } else {
                    mergedGasPerFunction.set(funcName, {...stats});
                }
            });
        }
    });

    const mergedExecutableLines = new Map<string, Set<number>>();
    coverages.forEach(coverage => {
        if (coverage.executableLines) {
            coverage.executableLines.forEach((lines, filePath) => {
                const existing = mergedExecutableLines.get(filePath) || new Set<number>();
                lines.forEach(lineNum => existing.add(lineNum));
                mergedExecutableLines.set(filePath, existing);
            });
        }
    });

    return {
        code: coverages[0].code,
        lines: mergedLines,
        gasPerFunction: mergedGasPerFunction.size > 0 ? mergedGasPerFunction : undefined,
        executableLines: mergedExecutableLines.size > 0 ? mergedExecutableLines : undefined,
    };
}

export function mergeTwoLines(
    first: readonly Line[],
    second: readonly Line[],
): readonly Line[] {
    if (first.length !== second.length) return first;

    const result: Line[] = [...first];

    for (const [index, line] of second.entries()) {
        const prev = result[index];
        if (!prev) continue;

        if (prev.info.$ === "Uncovered" && line.info.$ === "Uncovered") {
            // nothing changes
            continue;
        }

        if (prev.info.$ === "Skipped" && line.info.$ === "Skipped") {
            // nothing changes
            continue;
        }

        if (prev.info.$ === "Uncovered" && line.info.$ === "Covered") {
            // replace it with new data
            result[index] = line;
        }

        if (prev.info.$ === "Covered" && line.info.$ === "Uncovered") {
            // nothing changes
            continue;
        }

        if (prev.info.$ === "Covered" && line.info.$ === "Covered") {
            result[index] = {
                ...prev,
                info: {
                    ...prev.info,
                    hits: prev.info.hits + line.info.hits,
                    gasCosts: [...prev.info.gasCosts, ...line.info.gasCosts],
                },
            };
        }
    }

    return result;
};

