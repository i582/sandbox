import {generateTextReport, generateHtmlReport, collectTolkCoverage, mergeCoverages, CoverageData, coverageToJson, coverageFromJson} from "../";
import {mkdirSync, writeFileSync, existsSync} from "node:fs";
import {executeInstructions} from "./execute";
import {collectAsmCoverage} from "../collect";
import {Cell, TupleBuilder} from "@ton/core";
import {decompileCell} from "ton-assembly/dist/runtime";
import {runTolkCompiler, TolkSourceMap} from "@ton/tolk-js";
import {recompileCell} from "ton-assembly/dist/coverage";

describe("tolk coverage", () => {
    const test =
        (code: string, otherCode: string, id: number = 0) =>
            async () => {
                const name = expect.getState().currentTestName;

                const [tolkCompiled, sourceMap] = await compile(code, otherCode);
                const tolkInstructions = decompileCell(tolkCompiled);

                const cell = tolkCompiled

                const builder = new TupleBuilder()
                builder.writeNumber(10)
                builder.writeNumber(20)
                const [_, logs] = await executeInstructions(tolkInstructions, id, builder);
                const coverage = collectTolkCoverage(cell, logs, sourceMap?.sourcemap);
                const coverage2 = collectAsmCoverage(recompileCell(cell, false)[0], logs);

                console.log(coverage.gasPerFunction)

                const report = generateTextReport(coverage);
                expect(report).toMatchSnapshot();

                const outDirname = `${__dirname}/output`;
                if (!existsSync(outDirname)) {
                    mkdirSync(outDirname);
                }

                const htmlReport = generateHtmlReport(coverage);
                writeFileSync(`${__dirname}/output/${name}.html`, htmlReport);
                const htmlReport2 = generateHtmlReport(coverage2);
                writeFileSync(`${__dirname}/output/${name}-asm.html`, htmlReport2);
            };

    it(
        "simple if",
        test(
            `import "other";

struct Foo {
    x: int
}

@noinline
fun Foo.create(x: int): Foo {
    return Foo { x: x + 10 };
}

fun main(foo: int, bar: int) {
    if (
        foo > 10 && 
        bar > 100
    ) {
        foo = 20;
        return;
    }
    
    // comment here
    /*
        block one
    */

    assert (doSomething(foo, bar) > 10) throw 0xFFF;
        
    assert (Foo.create(foo).x) throw 0xFFF;
    assert (foo >= 10) throw 0xFFF;
    throw foo - 10;
}
            `,
            `
@noinline
fun doSomething(a: int, b: int) {
    return a + b;
}
            `,
        ),
    );

    it("merge coverage", () => {
        // Create two simple coverage objects for testing merge
        const coverage1: CoverageData = {
            code: new Cell(),
            lines: new Map([
                ["test1.tolk", [
                    { line: "line 1", info: { $: "Covered", hits: 1, gasCosts: [10] } },
                    { line: "line 2", info: { $: "Uncovered" } }
                ]]
            ]),
            gasPerFunction: new Map([
                ["func1", { gas: 100, instructions: 5 }]
            ]),
            executableLines: new Map([
                ["test1.tolk", new Set([1, 2])]
            ])
        };

        const coverage2: CoverageData = {
            code: new Cell(),
            lines: new Map([
                ["test1.tolk", [
                    { line: "line 1", info: { $: "Covered", hits: 2, gasCosts: [15] } },
                    { line: "line 2", info: { $: "Covered", hits: 1, gasCosts: [20] } }
                ]],
                ["test2.tolk", [
                    { line: "line A", info: { $: "Covered", hits: 3, gasCosts: [30] } }
                ]]
            ]),
            gasPerFunction: new Map([
                ["func1", { gas: 50, instructions: 3 }],
                ["func2", { gas: 75, instructions: 4 }]
            ]),
            executableLines: new Map([
                ["test1.tolk", new Set([1, 2])],
                ["test2.tolk", new Set([1])]
            ])
        };

        const merged = mergeCoverages(coverage1, coverage2);

        // Check merged lines
        expect(merged.lines.size).toBe(2); // test1.tolk and test2.tolk
        expect(merged.lines.get("test1.tolk")).toBeDefined();
        expect(merged.lines.get("test2.tolk")).toBeDefined();

        // Check merged gasPerFunction
        expect(merged.gasPerFunction?.size).toBe(2);
        expect(merged.gasPerFunction?.get("func1")).toEqual({ gas: 150, instructions: 8 });
        expect(merged.gasPerFunction?.get("func2")).toEqual({ gas: 75, instructions: 4 });

        // Check merged executableLines
        expect(merged.executableLines?.size).toBe(2);
        expect(merged.executableLines?.get("test1.tolk")?.size).toBe(2);
        expect(merged.executableLines?.get("test2.tolk")?.size).toBe(1);
    });
});

const compile = async (code: string, other: string): Promise<[Cell, TolkSourceMap | undefined]> => {
    const result = await runTolkCompiler({
        entrypointFileName: "main.tolk",
        fsReadCallback: (name) => {
            if (name === "main.tolk") {
                return code;
            }
            return other;
        },
        withStackComments: true,
        withSrcLineComments: true,
        generateSourceMap: true,
    })
    if (result.status === "error") {
        throw new Error(result.message)
    }

    return [Cell.fromBase64(result.debugCodeBoc64 ?? result.codeBoc64), result.sourceMap];
};
