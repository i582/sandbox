import {
    generateTextReport,
    generateHtmlReport,
    collectTolkCoverage,
} from "../";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { executeInstructions, executeInstructions2 } from "./execute";
import { collectAsmCoverage } from "../collect";
import { beginCell, Cell, TupleBuilder } from "@ton/core";
import { decompileCell } from "ton-assembly/dist/runtime";
import { runTolkCompiler } from "@ton/tolk-js";
import { SourceMap } from "ton-source-map";

describe("tolk coverage", () => {
    const test =
        (code: string, otherCode: string = "", storageCell: Cell = new Cell(), id: number = 0) =>
            async () => {
                const name = expect.getState().currentTestName;

                const [tolkCompiled, cleanCell, sourceMap] = await compile(code, otherCode);
                const tolkInstructions = decompileCell(cleanCell);

                const builder = new TupleBuilder();
                builder.writeNumber(10);
                builder.writeNumber(20);
                const [_, logs] = await executeInstructions(tolkInstructions, id, storageCell, builder, sourceMap);
                const coverage = collectTolkCoverage(logs, sourceMap!);

                const [_1, logs2] = await executeInstructions2(cleanCell, id, storageCell, builder);
                const coverage2 = collectAsmCoverage(cleanCell, logs2);

                console.log(coverage.gasPerFunction);

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

    it(
        "return after lazy",
        test(
            `
struct VaultStorage {
    totalAssets: int32
}
fun VaultStorage.load() { return VaultStorage.fromCell(contract.getData()) }
struct VaultConfig {}

fun totalAssets(vaultConfig: VaultConfig? = null) {
    var storage = lazy VaultStorage.load();
    return storage.totalAssets;
}

fun main() {
    return totalAssets(null);
}
            `,
            "",
            beginCell().storeInt(999, 32).endCell(),
        ),
    );

    it(
        "match over union type with subsequent implicit RET",
        test(
            `
type ExtraCurrencyId = uint32;
            
struct (0x0) TonAsset {}

struct (0x1) JettonAsset {
    jettonMaster: address;
}

struct (0x2) ExtraCurrencyAsset {
    extraCurrencyId: ExtraCurrencyId;
}

type Asset = TonAsset | JettonAsset | ExtraCurrencyAsset;

struct TransferParams {
    asset: Asset;
}

@inline_ref
fun processTonAsset(asset: TonAsset) {
    return 1;
}

fun transferAsset(transferParams: TransferParams) {
    var res = 0;

    match (transferParams.asset) {
        TonAsset => {
            res = processTonAsset(transferParams.asset);
        }
        JettonAsset => {
        }
        ExtraCurrencyAsset => {
        }
    }
    
    return res
}

fun main() {
    return transferAsset({ asset: TonAsset {} });
}
            `,
            "",
            beginCell().storeInt(999, 32).endCell(),
        ),
    );

    it(
        "match over integers",
        test(
            `
type RoundingType = uint2;

const ROUND_DOWN = 0;
const ROUND_UP = 1;
const ROUND_HALF_UP = 2;

@pure
fun RoundingType.Down() {
    return ROUND_DOWN;
}

@pure
fun RoundingType.Up() {
    return ROUND_UP;
}

@pure
fun RoundingType.HalfUp() {
    return ROUND_HALF_UP;
}

fun roundedMulDiv(x: int, y: int, z: int, rounding: RoundingType) {
    match (rounding) {
        ROUND_DOWN => {
            return mulDivFloor(x, y, z);
        }
        ROUND_UP => {
            return mulDivCeil(x, y, z);
        }
        ROUND_HALF_UP => {
            return mulDivRound(x, y, z);
        }
        else => {
            throw 0xFFF;
        }
    }
}

fun main() {
    return roundedMulDiv(1, 2, 3, ROUND_DOWN);
}
            `,
            "",
            beginCell().storeInt(999, 32).endCell(),
        ),
    );
});

const compile = async (code: string, other: string): Promise<[Cell, Cell, SourceMap | undefined]> => {
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
        collectSourceMap: true,
    });
    if (result.status === "error") {
        throw new Error(result.message);
    }

    return [
        Cell.fromBase64(result.sourceMapCodeBoc64 ?? result.codeBoc64),
        Cell.fromBase64(result.sourceMapCodeRecompiledBoc64 ?? result.codeBoc64),
        result.sourceMap
    ];
};
