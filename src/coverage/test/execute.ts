import {runtime} from "ton-assembly";
import type {Address, Contract, ContractProvider, Sender, StateInit, TupleReader} from "@ton/core";
import {Cell, contractAddress, toNano, TupleBuilder} from "@ton/core";
import {SandboxContract, TreasuryContract, Blockchain} from "../../";
import type {ContractGetMethodResult} from "@ton/core/dist/contract/ContractProvider";
import { SourceMapContract } from "../../blockchain/SmartContract";
import { SourceMap } from "ton-source-map";

export type ExtendedGetResult = ContractGetMethodResult & { vmLogs: string };

export async function executeInstructions(code: runtime.Instr[], id: number = 0, storageCell?: Cell, stack?: TupleBuilder, sourceMap?: SourceMap): Promise<[TupleReader, string]> {
    class TestContract extends SourceMapContract {
        public readonly address: Address;
        public readonly init?: StateInit;
        public readonly sourceMap?: SourceMap;

        public constructor(address: Address, init?: StateInit, sourceMap?: SourceMap) {
            super()
            this.address = address;
            this.init = init;
            this.sourceMap = sourceMap;
        }

        public async send(
            provider: ContractProvider,
            via: Sender,
            args: { value: bigint; bounce?: boolean | null | undefined },
            body: Cell,
        ) {
            await provider.internal(via, {...args, body: body});
        }

        public async getAny(
            provider: ContractProvider,
            id: number,
        ): Promise<[TupleReader, string]> {
            const builder = stack ?? new TupleBuilder();
            const res = (await provider.get(id, builder.build())) as ExtendedGetResult;
            return [res.stack, res.vmLogs];
        }
    }

    const blockchain: Blockchain = await Blockchain.create();
    blockchain.verbosity.print = false;
    blockchain.verbosity.vmLogs = "vm_logs_verbose";
    const treasure: SandboxContract<TreasuryContract> = await blockchain.treasury("treasure");

    const init: StateInit = {
        code: runtime.compileCell(code),
        data: storageCell ?? new Cell(),
    };

    const address = contractAddress(0, init);
    const contract = new TestContract(address, init, sourceMap);

    const openContract = blockchain.openContract(contract);

    await openContract.send(
        treasure.getSender(),
        {
            value: toNano("10"),
        },
        new Cell(),
    );

    return openContract.getAny(id);
}

export async function executeInstructions2(code: Cell, id: number = 0, storageCell?: Cell, stack?: TupleBuilder): Promise<[TupleReader, string]> {
    class TestContract implements Contract {
        public readonly address: Address;
        public readonly init?: StateInit;

        public constructor(address: Address, init?: StateInit) {
            this.address = address;
            this.init = init;
        }

        public async send(
            provider: ContractProvider,
            via: Sender,
            args: { value: bigint; bounce?: boolean | null | undefined },
            body: Cell,
        ) {
            await provider.internal(via, {...args, body: body});
        }

        public async getAny(
            provider: ContractProvider,
            id: number,
        ): Promise<[TupleReader, string]> {
            const builder = stack ?? new TupleBuilder();
            const res = (await provider.get(id, builder.build())) as ExtendedGetResult;
            return [res.stack, res.vmLogs];
        }
    }

    const blockchain: Blockchain = await Blockchain.create();
    blockchain.verbosity.print = false;
    blockchain.verbosity.vmLogs = "vm_logs_verbose";
    const treasure: SandboxContract<TreasuryContract> = await blockchain.treasury("treasure");

    const init: StateInit = {
        code: code,
        data: storageCell,
    };

    const address = contractAddress(0, init);
    const contract = new TestContract(address, init);

    const openContract = blockchain.openContract(contract);

    await openContract.send(
        treasure.getSender(),
        {
            value: toNano("10"),
        },
        new Cell(),
    );

    return openContract.getAny(id);
}
