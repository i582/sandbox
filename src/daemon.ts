import express from 'express';
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress, ContractGetMethodResult,
    ContractProvider, external,
    Sender,
    StateInit, storeShardAccount,
    toNano,
    TupleBuilder,
} from '@ton/core';
import {Blockchain, BlockchainSender, internal, SandboxContract, TreasuryContract} from '../src';

export type ExtendedGetResult = ContractGetMethodResult & { vmLogs: string }

interface DeployRequest {
    readonly stateInit: {
        readonly code: string; // base64
        readonly data: string; // base64
    };
    readonly value?: string; // nano TON amount
    readonly name?: string;
    readonly sourceMap?: object;
    readonly abi?: object;
}

interface SendMessageRequest {
    readonly address: string;
    readonly message: string; // base64 Cell
    readonly sendMode: number;
    readonly value?: string; // nano TON amount
}

interface SendExternalMessageRequest {
    readonly address: string;
    readonly message: string; // base64 Cell
}

interface SendInternalMessageRequest {
    readonly fromAddress: string;
    readonly toAddress: string;
    readonly message: string; // base64 Cell
    readonly sendMode: number;
    readonly value?: string; // nano TON amount
}

interface GetMethodRequest {
    readonly address: string;
    readonly methodId: number;
}

interface InfoMethodRequest {
    readonly address: string;
}

class DaemonContract implements Contract {
    public readonly address: Address;
    public readonly init: StateInit;
    public readonly sourceMap?: object;
    public readonly name?: string;
    public readonly abi?: object;

    constructor(address: Address, init: StateInit, sourceMap: object | undefined, name?: string, abi?: object) {
        this.address = address;
        this.init = init;
        this.sourceMap = sourceMap;
        this.name = name;
        this.abi = abi;
    }

    async send(
        provider: ContractProvider,
        via: Sender,
        args: { value: bigint; bounce?: boolean },
        body: Cell,
        sendMode: number,
    ) {
        await provider.internal(via, {...args, sendMode, body});
    }

    async getAny(provider: ContractProvider, id: number) {
        const builder = new TupleBuilder();
        const res = (await provider.get(id, builder.build())) as ExtendedGetResult;
        return [res.stack, res.vmLogs];
    }
}

class SandboxDaemon {
    private blockchain: Blockchain;
    private treasury: SandboxContract<TreasuryContract>;
    private contracts: Map<string, SandboxContract<DaemonContract>> = new Map();
    private contractInfos: Map<string, { name?: string; sourceMap?: object; abi?: object }> = new Map();

    constructor(blockchain: Blockchain, treasury: SandboxContract<TreasuryContract>) {
        this.blockchain = blockchain;
        this.treasury = treasury;
    }

    static async create(): Promise<SandboxDaemon> {
        const blockchain = await Blockchain.create({webUI: true});
        blockchain.verbosity.print = false;
        blockchain.verbosity.vmLogs = "vm_logs_verbose";

        const treasury = await blockchain.treasury("treasury");

        return new SandboxDaemon(blockchain, treasury);
    }

    async deployContract(name: string, stateInit: StateInit, valueAmount: bigint, sourceMap: object | undefined, abi: object | undefined): Promise<{
        address: string;
        success: boolean
    }> {
        try {
            const address = contractAddress(0, stateInit);
            const contract = new DaemonContract(address, stateInit, sourceMap, name, abi);
            const openContract = this.blockchain.openContract(contract, name);

            // Deploy with empty message
            await openContract.send(
                this.treasury.getSender(),
                {value: valueAmount},
                new Cell(),
                0, // TODO
            );

            this.contracts.set(address.toString(), openContract);
            this.contractInfos.set(address.toString(), {
                name: name,
                sourceMap: sourceMap,
                abi: abi
            });

            return {
                address: address.toString(),
                success: true,
            };
        } catch (error) {
            console.error('Deploy error:', error);
            return {
                address: '',
                success: false,
            };
        }
    }

    /**
     * Send external message from treasury to contract
     */
    async sendExternalMessage(address: string, message: Cell): Promise<{
        success: boolean;
        txs?: {
            addr?: string;
            vmLogs?: string;
            code?: string;
            mapping?: object;
        }[]
        error?: string
    }> {
        try {
            const contract = this.contracts.get(address);
            if (!contract) {
                return {success: false, error: 'Contract not found'};
            }

            const result = await this.blockchain.sendMessage(external({
                to: contract.address,
                body: message,
            }));

            return {
                success: true,
                txs: result.transactions.slice(1).map(tx => {
                    const addr = (tx.inMessage?.info.dest as Address).toString();
                    const code = (this.contracts.get(addr)?.init?.code ?? new Cell()).toBoc().toString("hex");
                    return ({
                        addr: addr,
                        vmLogs: tx.vmLogs,
                        code: code,
                        sourceMap: this.contracts.get(addr)?.sourceMap,
                    });
                })
            };
        } catch (error) {
            console.error('Send message error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async callGetMethod(address: string, methodId: number): Promise<{
        success: boolean;
        result?: any;
        logs?: string;
        error?: string
    }> {
        try {
            const contract = this.contracts.get(address);
            if (!contract) {
                return {success: false, error: 'Contract not found'};
            }

            const [stack, logs] = await contract.getAny(methodId);

            const serializeStack = (stack: any) => {
                if (!stack) return null;

                try {
                    // Получаем первый элемент стека как число
                    const value = stack.readBigNumber();
                    return value.toString();
                } catch (e) {
                    // Если не получается прочитать как число, возвращаем строковое представление
                    return stack.toString();
                }
            };

            return {
                success: true,
                result: serializeStack(stack),
                logs: typeof logs === 'string' ? logs : logs.toString(),
            };
        } catch (error) {
            console.error('Get method error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    getDeployedContracts(): Array<{ address: string; name?: string; sourceMap?: object; abi?: object }> {
        const contracts = Array.from(this.contracts.entries()).map(([address]) => {
            const info = this.contractInfos.get(address);
            return {
                address,
                name: info?.name,
                sourceMap: info?.sourceMap,
                abi: info?.abi,
            };
        });

        // Add treasury contract to the list
        contracts.unshift({
            address: this.treasury.address.toString(),
            name: "treasury",
            sourceMap: undefined,
            abi: undefined,
        });

        return contracts;
    }

    async getInfo(address: string): Promise<{
        success: boolean;
        result?: {
            account: string;
            stateInit?: {
                code: string;
                data: string;
            };
            abi?: object;
        };
        error?: string
    }> {
        try {
            // Check if it's treasury
            if (address === this.treasury.address.toString()) {
                const blockchainContract = await this.blockchain.getContract(this.treasury.address)

                const accountCell = beginCell().store(storeShardAccount(blockchainContract.account)).endCell()

                let stateInit: { code: string; data: string } | undefined
                if (this.treasury.init && this.treasury.init.code && this.treasury.init.data) {
                    stateInit = {
                        code: this.treasury.init.code.toBoc().toString("base64"),
                        data: this.treasury.init.data.toBoc().toString("base64")
                    }
                }

                return {
                    success: true,
                    result: {
                        account: accountCell.toBoc().toString("hex"),
                        stateInit,
                        abi: undefined, // Treasury doesn't have ABI
                    },
                };
            }

            const contract = this.contracts.get(address);
            if (!contract) {
                return {success: false, error: 'Contract not found'};
            }

            const blockchainContract = await this.blockchain.getContract(contract.address)

            const accountCell = beginCell().store(storeShardAccount(blockchainContract.account)).endCell()

            let stateInit: { code: string; data: string } | undefined
            if (contract.init && contract.init.code && contract.init.data) {
                stateInit = {
                    code: contract.init.code.toBoc().toString("base64"),
                    data: contract.init.data.toBoc().toString("base64")
                }
            }

            const contractInfo = this.contractInfos.get(address)
            const abi = contractInfo?.abi

            return {
                success: true,
                result: {
                    account: accountCell.toBoc().toString("hex"),
                    stateInit,
                    abi,
                },
            };
        } catch (error) {
            console.error('Get method error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async sendInternalMessage(fromAddress: string, toAddress: string, message: Cell, sendMode: number, value: bigint = toNano("1")): Promise<{
        success: boolean;
        txs?: {
            addr?: string;
            vmLogs?: string;
            code?: string;
            sourceMap?: object;
        }[]
        error?: string
    }> {
        try {
            const fromContract = fromAddress === this.treasury.address.toString()
                ? this.treasury
                : this.contracts.get(fromAddress);
            if (!fromContract) {
                return {success: false, error: 'From contract not found'};
            }

            const toContract = this.contracts.get(toAddress);
            if (!toContract) {
                return {success: false, error: 'To contract not found'};
            }

            const internalMsg = internal({
                from: fromContract.address,
                to: toContract.address,
                value: value,
                body: message,
                bounce: false,
            });

            const result = await (async () => {
                if (fromAddress === this.treasury.address.toString()) {
                    return toContract.send(this.treasury.getSender(), {value, bounce: false}, message, sendMode)
                }

                return await this.blockchain.sendMessage(internalMsg);
            }) ()

            return {
                success: true,
                txs: result.transactions.slice(1).map(tx => {
                    const addr = (tx.inMessage?.info.dest as Address).toString();
                    const code = (this.contracts.get(addr)?.init?.code ?? new Cell()).toBoc().toString("hex");
                    return ({
                        addr: addr,
                        vmLogs: tx.vmLogs,
                        code: code,
                        sourceMap: this.contracts.get(addr)?.sourceMap,
                    });
                })
            };
        } catch (error) {
            console.error('Send internal message error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

}

const app = express();
app.use(express.json());

let daemon: SandboxDaemon;

const initDaemon = async () => {
    daemon = await SandboxDaemon.create();
    console.log('Sandbox daemon initialized');
};

app.post('/deploy', async (req, res) => {
    try {
        const {stateInit, value, name, sourceMap, abi}: DeployRequest = req.body;

        if (!stateInit?.code || !stateInit?.data) {
            return res.status(400).json({error: 'Missing stateInit.code or stateInit.data'});
        }

        const valueAmount = value ? toNano(value) : toNano("1");

        const init: StateInit = {
            code: Cell.fromBase64(stateInit.code),
            data: Cell.fromBase64(stateInit.data),
        };

        const result = await daemon.deployContract(name ?? "UnknownContract", init, valueAmount, sourceMap, abi);
        res.json(result);
    } catch (error) {
        console.error('Deploy endpoint error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/send-external', async (req, res) => {
    try {
        const {address, message}: SendExternalMessageRequest = req.body;

        if (!address || !message) {
            return res.status(400).json({error: 'Missing address or message'});
        }

        const messageCell = Cell.fromBase64(message);

        const result = await daemon.sendExternalMessage(address, messageCell);
        res.json(result);
    } catch (error) {
        console.error('Send external endpoint error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/send-internal', async (req, res) => {
    try {
        const {fromAddress, toAddress, message, sendMode, value}: SendInternalMessageRequest = req.body;

        if (!fromAddress || !toAddress || !message) {
            return res.status(400).json({error: 'Missing fromAddress, toAddress or message'});
        }

        const messageCell = Cell.fromBase64(message);
        const valueAmount = value ? toNano(value) : toNano("1");

        const result = await daemon.sendInternalMessage(fromAddress, toAddress, messageCell, sendMode, valueAmount);
        res.json(result);
    } catch (error) {
        console.error('Send internal endpoint error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/get', async (req, res) => {
    try {
        const {address, methodId}: GetMethodRequest = req.body;

        if (!address || methodId === undefined) {
            return res.status(400).json({error: 'Missing address or methodId'});
        }

        const result = await daemon.callGetMethod(address, methodId);
        res.json(result);
    } catch (error) {
        console.error('Get endpoint error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/info', async (req, res) => {
    try {
        const {address}: InfoMethodRequest = req.body;

        if (!address) {
            return res.status(400).json({error: 'Missing address'});
        }

        const result = await daemon.getInfo(address);
        res.json(result);
    } catch (error) {
        console.error('Get endpoint error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/contracts', async (_req, res) => {
    try {
        const deployedContracts = daemon.getDeployedContracts();
        const contracts = deployedContracts.map(({address, name, sourceMap, abi}) => ({
            address,
            name: name ?? "Unknown",
            sourceMap,
            abi
        }));
        res.json({contracts});
    } catch (error) {
        console.error('Get contracts error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/health', (_req, res) => {
    res.json({status: 'ok', timestamp: new Date().toISOString()});
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await initDaemon();
    app.listen(PORT, () => {
        console.log(`Sandbox daemon server running on port ${PORT}`);
        console.log(`Available endpoints:`);
        console.log(`  POST /deploy - Deploy contract`);
        console.log(`  POST /send-external - Send external message to contract`);
        console.log(`  POST /send-internal - Send message from contract to contract`);
        console.log(`  POST /get - Call get method`);
        console.log(`  POST /info - Get contract info`);
        console.log(`  GET /contracts - Get deployed contracts`);
        console.log(`  GET /health - Health check`);
    });
};

if (require.main === module) {
    startServer().catch(console.error);
}

export {SandboxDaemon};
