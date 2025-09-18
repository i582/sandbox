import {Cell} from "@ton/core";
import {CoverageData, Line} from "./data";

export function coverageToJson(coverage: CoverageData): string {
    const linesObject: Record<string, any[]> = {};

    for (const [filePath, fileLines] of coverage.lines) {
        linesObject[filePath] = fileLines.map((line, index) => {
            if (line.info.$ === "Covered") {
                return {
                    lineNumber: index,
                    line: line.line,
                    info: {
                        ...line.info,
                    },
                };
            }
            return {
                lineNumber: index,
                ...line,
            };
        });
    }

    return JSON.stringify({
        code: coverage.code.toBoc().toString("hex"),
        lines: linesObject,
        executableLines: coverage.executableLines ? Object.fromEntries(coverage.executableLines) : undefined,
        gasPerFunction: coverage.gasPerFunction ? Object.fromEntries(coverage.gasPerFunction) : undefined,
    });
}

export function coverageFromJson(string: string): CoverageData {
    type CoverageJson = {
        readonly code: string;
        readonly lines: Record<string, any[]>;
        readonly executableLines?: Record<string, number[]>;
        readonly gasPerFunction?: Record<string, { gas: number; instructions: number }>;
    };

    const data = JSON.parse(string) as CoverageJson;

    const lines = new Map<string, Line[]>();
    for (const [filePath, fileLines] of Object.entries(data.lines)) {
        lines.set(filePath, fileLines.map(item => ({
            line: item.line,
            info: item.info,
        })));
    }

    const executableLines = data.executableLines ? new Map(Object.entries(data.executableLines).map(([file, lines]) => [file, new Set(lines)])) : undefined;
    const gasPerFunction = data.gasPerFunction ? new Map(Object.entries(data.gasPerFunction)) : undefined;

    return {
        code: Cell.fromHex(data.code),
        lines,
        executableLines,
        gasPerFunction,
    };
}
