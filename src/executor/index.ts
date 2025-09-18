import {
    Address,
    beginCell,
    Cell,
    Contract, contractAddress,
    ContractProvider,
    Sender,
    type StateInit, toNano,
    TupleBuilder,
    TupleReader
} from "@ton/core";
import {Blockchain, type SandboxContract} from "../blockchain/Blockchain";
import {TreasuryContract} from "../treasury/Treasury";
import {runTolkCompiler} from "@ton/tolk-js";

export const compileTolkCode = async (code: string): Promise<Cell | undefined> => {
    const result = await runTolkCompiler({
        entrypointFileName: "main.tolk",
        fsReadCallback: () => code,
        withStackComments: true,
        withSrcLineComments: true,
    })
    if (result.status === "error") {
        throw new Error(result.message)
    }
    return Cell.fromBase64(result.codeBoc64)
}

export const executeInstructions = async (
    codeCell: Cell,
    id: number = 0,
): Promise<[TupleReader, string]> => {
    class TestContract implements Contract {
        public readonly address: Address
        public readonly init?: StateInit

        public constructor(address: Address, init?: StateInit) {
            this.address = address
            this.init = init
        }

        public async send(
            provider: ContractProvider,
            via: Sender,
            args: { value: bigint; bounce?: boolean | null | undefined },
            body: Cell,
        ) {
            await provider.internal(via, {...args, body: body})
        }

        public async getAny(
            provider: ContractProvider,
            id: number,
        ): Promise<[TupleReader, string]> {
            const builder = new TupleBuilder()
            const res = await provider.get(id, builder.build())

            // @ts-expect-error TS2551
            return [res.stack, res.vmLogs]
        }
    }

    console.log(codeCell.toBoc().toString("hex"))

    const blockchain: Blockchain = await Blockchain.create()
    blockchain.verbosity.print = false
    blockchain.verbosity.vmLogs = "vm_logs_verbose"
    const treasure: SandboxContract<TreasuryContract> = await blockchain.treasury("treasure")

    const init: StateInit = {
        code: codeCell,
        data: beginCell().storeUint(0, 32).storeUint(1, 32).endCell(),
    }

    const address = contractAddress(0, init)
    const contract = new TestContract(address, init)

    const openContract = blockchain.openContract(contract)

    const contract2 = await blockchain.getContract(contract.address);
    contract2.setDebug(true);

    // Deploy
    await openContract.send(
        treasure.getSender(),
        {
            value: toNano("10"),
        },
        beginCell().storeUint(0x3a752f06, 32).storeUint(0, 32).endCell(),
    )

    const [stack, vmLogs] = await openContract.getAny(id)
    return [stack, vmLogs]
}


const main = async () => {
    const res = await compileTolkCode(`
tolk 1.0

struct Storage {
    id: uint32
    counter: uint32
}

fun Storage.load() {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

struct (0x7e8764ef) IncreaseCounter {
    queryId: uint64
    increaseBy: uint32
}

struct (0x3a752f06) ResetCounter {
    queryId: int32
}

struct (0x2) Bounce {}
struct (0x3) Destroy {}

const FOO = 100 + 200

type AllowedMessage = IncreaseCounter | ResetCounter

@inline_ref
fun foo() {
    return bar();
}

@inline_ref
fun bar() {
    return 10;
}

fun onInternalMessage(in: InMessage) {
    val res = foo();
    if (res == 100) {
        throw 10;
    }

    val msg = lazy AllowedMessage.fromSlice(in.body);
    
    match (msg) {
        IncreaseCounter => {
            var storage = lazy Storage.load();
            storage.counter += msg.increaseBy;
 
            try {
                throw 5;
            } catch (e) {
                storage.counter += e;
            }

            storage.save();

            // send Destroy to other
            val outMsg = createMessage({
                dest: address("EQC8E5aoOpjeW0FF6r_Dx5uJxU8gcUxVO03lgkUcb1ophAzO"),
                body: Destroy {},
                bounce: false,
                value: ton("0.1"),
            });
            outMsg.send(SEND_MODE_REGULAR);
        }

        ResetCounter => {
            var storage = lazy Storage.load();
            storage.counter = 0;
            storage.save();

            // send Bounce to other
            val msg = createMessage({
                dest: address("EQC8E5aoOpjeW0FF6r_Dx5uJxU8gcUxVO03lgkUcb1ophAzO"),
                body: Bounce {},
                bounce: true,
                value: ton("0.1"),
            });
            msg.send(SEND_MODE_REGULAR);
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF;
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    val msg = lazy Bounce.fromSlice(in.bouncedBody.skipBouncedPrefix());

    match (msg) {
        Bounce => {
            var storage = lazy Storage.load();
            storage.counter = 9999;
            storage.save();
        }
        else => {}
    }
}

get fun currentCounter(): int {
    val storage = lazy Storage.load();
    return storage.counter;
}

get fun initialId(): int {
    val storage = lazy Storage.load();
    return storage.id;
}

        `)
    if (!res) {
        return
    }

    const execRes = await executeInstructions(res, 117456)
    console.log(execRes)
}

void main()
