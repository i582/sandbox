import express from 'express';
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractGetMethodResult,
    ContractProvider,
    external,
    parseTuple,
    Sender,
    serializeTuple,
    StateInit,
    storeShardAccount,
    storeTransaction,
    Transaction,
    TupleItem,
    TupleReader,
} from '@ton/core';

import {
    Blockchain,
    BlockchainSnapshot,
    BlockchainTransaction,
    SandboxContract,
    SendMessageResult,
    TreasuryContract,
} from '../src';
import { bigintToAddress } from './blockchain/web-ui-websocket';

declare const base64Brand: unique symbol;
export type Base64String = string & { readonly [base64Brand]: true };

export type ExtendedGetResult = ContractGetMethodResult & { vmLogs: string };

export type DeployContractServerData = {
    readonly address: string;
};

export type SendMessageServerData = {
    readonly txs: readonly {
        readonly addr: string;
        readonly vmLogs: string;
        readonly code?: string;
        readonly sourceMap?: object;
    }[];
};

export type CallGetMethodServerData = {
    readonly result?: string;
    readonly logs?: string;
};

export type GetMessageTemplatesServerData = {
    readonly templates: MessageTemplate[];
};

export type GetContractsServerData = {
    readonly contracts: DeployedContractInfo[];
};

export type GetOperationsServerData = {
    readonly operations: OperationNode[];
};

export type LoadContractInfoServerData = ContractStateInfo;

export type CreateMessageTemplateServerData = MessageTemplate;

type ApiResponse<T = object> = ApiResponseOk<T> | ApiResponseError;

interface ApiResponseOk<T = object> {
    readonly success: true;
    readonly data: T;
}

interface ApiResponseError {
    readonly success: false;
    readonly error: string;
}

interface DeployRequest {
    readonly stateInit: {
        readonly code: Base64String;
        readonly data: Base64String;
    };
    readonly value: string; // nano TON amount
    readonly name: string;
    readonly sourceMap?: object;
    readonly abi?: object;
    readonly sourceUri: string; // URI of the source file
}

interface MessageTemplate {
    readonly id: string;
    readonly name: string;
    readonly opcode: number; // message opcode for filtering
    readonly messageFields: Record<string, { type: object; value: string } | undefined>;
    readonly sendMode: number;
    readonly value: string; // nano TON amount
    readonly createdAt: string; // ISO date string
    readonly description?: string;
}

interface CreateTemplateRequest {
    readonly name: string;
    readonly opcode: number;
    readonly messageFields: Record<string, { type: object; value: string } | undefined>;
    readonly sendMode: number;
    readonly value: string; // nano TON amount
    readonly description?: string;
}

interface SendExternalMessageRequest {
    readonly address: string;
    readonly message: Base64String;
}

interface SendInternalMessageRequest {
    readonly fromAddress: string;
    readonly toAddress: string;
    readonly message: Base64String; // base64 Cell
    readonly sendMode: number;
    readonly value: string;
}

interface GetMethodRequest {
    readonly address: string;
    readonly methodId: number;
    readonly parameters: Base64String;
}

interface InfoMethodRequest {
    readonly address: string;
}

interface RenameContractRequest {
    readonly address: string;
    readonly newName: string;
}

export interface OperationNode {
    readonly id: string;
    readonly type: 'deploy' | 'send-internal' | 'send-external';
    readonly timestamp: string;
    readonly contractName?: string;
    readonly contractAddress?: string;
    readonly success: boolean;
    readonly details?: string;
    readonly fromContract?: string;
    readonly toContract?: string;
    readonly sendResult?: SendMessageResult;
}

class DaemonContract implements Contract {
    constructor(
        public readonly address: Address,
        public readonly init: StateInit,
        public readonly sourceMap: object | undefined,
        public readonly name?: string,
        public readonly abi?: object,
    ) {}

    public async send(
        provider: ContractProvider,
        via: Sender,
        args: { value: bigint; bounce?: boolean },
        body: Cell,
        sendMode: number,
    ) {
        await provider.internal(via, { ...args, sendMode, body });
    }

    public async getAny(
        provider: ContractProvider,
        id: number,
        parametersBase64: string,
    ): Promise<[TupleReader, string]> {
        let parameters: TupleItem[] = [];

        try {
            const paramCell = Cell.fromBase64(parametersBase64);
            parameters = parseTuple(paramCell);
        } catch (error) {
            console.warn('Failed to parse parameters:', error);
        }

        console.log('Call get method with id', id, 'and parameters:', parameters, '');
        const res = (await provider.get(id, parameters)) as ExtendedGetResult;
        return [res.stack, res.vmLogs];
    }
}

export interface BlockchainDaemonSnapshot {
    readonly blockchain: BlockchainSnapshot;
    readonly contracts: Map<string, SandboxContract<DaemonContract>>;
    readonly contractInfos: Map<string, DeployedContractInfo>;
    readonly operations: OperationNode[];
}

export interface SendMessageTransactionInfo {
    readonly addr: string;
    readonly vmLogs: string;
    readonly code: string;
    readonly sourceMap?: object;
}

export interface DeployedContractInfo {
    readonly address: string;
    readonly name: string;
    readonly sourceMap?: object;
    readonly abi?: object;
    readonly sourceUri: string;
}

export interface ContractStateInfo {
    readonly account: string;
    readonly stateInit?: {
        readonly code: string;
        readonly data: string;
    };
    readonly abi?: object;
    readonly sourceUri: string;
}

class SandboxDaemon {
    public contracts: Map<string, SandboxContract<DaemonContract>> = new Map();
    public contractInfos: Map<string, DeployedContractInfo> = new Map();
    public operations: OperationNode[] = [];
    public snapshots: Map<string, BlockchainDaemonSnapshot> = new Map();
    public messageTemplates: Map<string, MessageTemplate> = new Map();

    public static async create(): Promise<SandboxDaemon> {
        const blockchain = await Blockchain.create({ webUI: true });
        blockchain.verbosity.print = false;
        blockchain.verbosity.vmLogs = 'vm_logs_verbose';

        const treasury = await blockchain.treasury('treasury');
        return new SandboxDaemon(blockchain, treasury);
    }

    constructor(
        public blockchain: Blockchain,
        public treasury: SandboxContract<TreasuryContract>,
    ) {
        this.contractInfos.set(treasury.address.toString(), {
            address: treasury.address.toString(),
            name: 'treasury',
            sourceMap: undefined,
            abi: undefined,
            sourceUri: 'treasury.func',
        });

        try {
            const initialDaemonStateSnapshot: BlockchainDaemonSnapshot = {
                blockchain: this.blockchain.snapshot(),
                contracts: new Map(this.contracts),
                contractInfos: new Map(this.contractInfos),
                operations: [],
            };
            this.snapshots.set('initial', initialDaemonStateSnapshot);
            console.log('Saved initial daemon state snapshot');
        } catch (error) {
            console.warn('Failed to save initial snapshot:', error);
        }
    }

    private addOperation(operation: Omit<OperationNode, 'id' | 'timestamp'>): void {
        const newOperation: OperationNode = {
            id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
            timestamp: new Date().toISOString(),
            ...operation,
        };

        if (operation.success) {
            try {
                const daemonStateSnapshot: BlockchainDaemonSnapshot = {
                    blockchain: this.blockchain.snapshot(),
                    contracts: new Map(this.contracts),
                    contractInfos: new Map(this.contractInfos),
                    operations: [...this.operations],
                };
                this.snapshots.set(newOperation.id, daemonStateSnapshot);
                console.log(`Saved full daemon state snapshot for operation ${newOperation.id}`);
            } catch (error) {
                console.warn(`Failed to save snapshot for operation ${newOperation.id}:`, error);
            }
        }

        this.operations.push(newOperation);
    }

    public async deployContract(
        name: string,
        stateInit: StateInit,
        valueAmount: bigint,
        sourceMap: object | undefined,
        abi: object | undefined,
        sourceUri: string,
    ): Promise<ApiResponse<DeployContractServerData>> {
        try {
            const address = contractAddress(0, stateInit);
            const contract = new DaemonContract(address, stateInit, sourceMap, name, abi);
            const openContract = this.blockchain.openContract(contract, name);

            await openContract.send(
                this.treasury.getSender(),
                { value: valueAmount },
                new Cell(),
                0, // TODO
            );

            this.contracts.set(address.toString(), openContract);
            this.contractInfos.set(address.toString(), {
                address: address.toString(),
                name: name,
                sourceMap: sourceMap,
                abi: abi,
                sourceUri: sourceUri,
            });

            this.addOperation({
                type: 'deploy',
                contractName: name,
                contractAddress: address.toString(),
                details: `Deployed ${name} with initial value`,
                success: true,
            });

            return {
                success: true,
                data: {
                    address: address.toString(),
                },
            };
        } catch (error) {
            console.error('Deploy error:', error);

            this.addOperation({
                type: 'deploy',
                contractName: name,
                details: `Failed to deploy ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                success: false,
            });

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    private blockchainTxToInfo(tx: BlockchainTransaction): SendMessageTransactionInfo {
        const addr = (tx.inMessage?.info.dest as Address).toString();
        const contract = this.contracts.get(addr);
        const code = (contract?.init?.code ?? new Cell()).toBoc().toString('hex');
        return {
            addr: addr,
            vmLogs: tx.vmLogs,
            code: code,
            sourceMap: contract?.sourceMap,
        };
    }

    public async sendExternalMessage(address: string, message: Cell): Promise<ApiResponse<SendMessageServerData>> {
        try {
            const contract = this.contracts.get(address);
            if (!contract) {
                return { success: false, error: 'Contract not found' };
            }

            const result = await this.blockchain.sendMessage(
                external({
                    to: contract.address,
                    body: message,
                }),
            );

            const contractInfo = this.contractInfos.get(address);
            this.addOperation({
                type: 'send-external',
                contractName: contractInfo?.name,
                contractAddress: address,
                details: `External message sent to ${contractInfo?.name || address}`,
                success: true,
                sendResult: result,
            });

            return {
                success: true,
                data: {
                    txs: result.transactions.slice(1).map((tx) => this.blockchainTxToInfo(tx)),
                },
            };
        } catch (error) {
            console.error('Send message error:', error);

            const contractInfo = this.contractInfos.get(address);
            this.addOperation({
                type: 'send-external',
                contractName: contractInfo?.name,
                contractAddress: address,
                details: `Failed to send external message to ${contractInfo?.name || address}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                success: false,
            });

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    public async sendInternalMessage(
        fromAddress: string,
        toAddress: string,
        message: Cell,
        sendMode: number,
        value: bigint,
    ): Promise<ApiResponse<SendMessageServerData>> {
        try {
            const fromContract =
                fromAddress === this.treasury.address.toString() ? this.treasury : this.contracts.get(fromAddress);
            if (!fromContract) {
                return { success: false, error: 'From contract not found' };
            }

            const toContract = this.contracts.get(toAddress);
            if (!toContract) {
                return { success: false, error: 'To contract not found' };
            }

            const fromContractSender = this.blockchain.sender(fromContract.address);

            const result = await toContract.send(fromContractSender, { value, bounce: false }, message, sendMode);

            this.addOperation({
                type: 'send-internal',
                fromContract: fromAddress,
                toContract: toAddress,
                success: true,
                sendResult: result,
            });

            return {
                success: true,
                data: {
                    txs: result.transactions.slice(0, -1).map((tx) => this.blockchainTxToInfo(tx)),
                },
            };
        } catch (error) {
            console.error('Send internal message error:', error);

            this.addOperation({
                type: 'send-internal',
                fromContract: fromAddress,
                toContract: toAddress,
                details: error instanceof Error ? error.message : 'Unknown error',
                success: false,
            });

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    public async callGetMethod(
        address: string,
        methodId: number,
        parametersBase64: string,
    ): Promise<ApiResponse<CallGetMethodServerData>> {
        try {
            const contract = this.contracts.get(address);
            if (!contract) {
                return { success: false, error: 'Contract not found' };
            }

            const [stack, logs] = await contract.getAny(methodId, parametersBase64);

            // @ts-expect-error we need items as an array, and there is no other way to get it AFAIK
            const items = stack.items as TupleItem[];
            return {
                success: true,
                data: {
                    result: serializeTuple(items).toBoc().toString('base64'),
                    logs,
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

    public getDeployedContracts(): DeployedContractInfo[] {
        return [...this.contractInfos.values()];
    }

    public removeContract(address: string): boolean {
        if (address === this.treasury.address.toString()) {
            // Don't allow removing treasury contract
            return false;
        }

        this.contracts.delete(address);
        this.contractInfos.delete(address);
        return true;
    }

    public async getInfo(address: string): Promise<ApiResponse<LoadContractInfoServerData>> {
        try {
            if (address === this.treasury.address.toString()) {
                const blockchainContract = await this.blockchain.getContract(this.treasury.address);
                const accountCell = beginCell().store(storeShardAccount(blockchainContract.account)).endCell();
                let stateInit: { code: string; data: string } | undefined;
                if (this.treasury.init && this.treasury.init.code && this.treasury.init.data) {
                    stateInit = {
                        code: this.treasury.init.code.toBoc().toString('base64'),
                        data: this.treasury.init.data.toBoc().toString('base64'),
                    };
                }

                return {
                    success: true,
                    data: {
                        account: accountCell.toBoc().toString('hex'),
                        stateInit,
                        abi: undefined,
                        sourceUri: 'treasury.func',
                    },
                };
            }

            const contract = this.contracts.get(address);
            if (!contract) {
                return { success: false, error: 'Contract not found' };
            }

            const blockchainContract = await this.blockchain.getContract(contract.address);
            const accountCell = beginCell().store(storeShardAccount(blockchainContract.account)).endCell();
            let stateInit: { code: string; data: string } | undefined;
            if (contract.init && contract.init.code && contract.init.data) {
                stateInit = {
                    code: contract.init.code.toBoc().toString('base64'),
                    data: contract.init.data.toBoc().toString('base64'),
                };
            }

            const contractInfo = this.contractInfos.get(address);
            if (!contractInfo) {
                console.warn(`Contract ${address} has no info!`);
            }

            const abi = contractInfo?.abi;
            const sourceUri = contractInfo?.sourceUri ?? 'unknown.tolk';

            return {
                success: true,
                data: {
                    account: accountCell.toBoc().toString('hex'),
                    stateInit,
                    abi,
                    sourceUri,
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

    public async renameContract(address: string, newName: string): Promise<ApiResponse> {
        try {
            const contractInfo = this.contractInfos.get(address);
            if (!contractInfo) {
                return { success: false, error: 'Contract not found' };
            }

            this.contractInfos.set(address, {
                ...contractInfo,
                name: newName,
            });

            console.log(`Renamed contract ${address} to "${newName}"`);

            return {
                success: true,
                data: {},
            };
        } catch (error) {
            console.error('Rename contract error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    public createMessageTemplate(
        templateData: Omit<MessageTemplate, 'id' | 'createdAt'>,
    ): ApiResponse<CreateMessageTemplateServerData> {
        const id = `template_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        const template: MessageTemplate = {
            id,
            name: templateData.name,
            opcode: templateData.opcode,
            messageFields: templateData.messageFields,
            sendMode: templateData.sendMode,
            value: templateData.value,
            description: templateData.description,
            createdAt: new Date().toISOString(),
        };
        this.messageTemplates.set(id, template);
        console.log(`Created message template: ${template.name} (${id})`);
        return {
            success: true,
            data: template,
        };
    }

    public getMessageTemplates(): ApiResponse<GetMessageTemplatesServerData> {
        return {
            success: true,
            data: {
                templates: [...this.messageTemplates.values()],
            },
        };
    }

    public deleteMessageTemplate(id: string): ApiResponse {
        const deleted = this.messageTemplates.delete(id);
        if (deleted) {
            console.log(`Deleted message template: ${id}`);
            return { success: true, data: {} };
        }
        return { success: false, error: 'Template not found' };
    }

    public getLatestOperation(): OperationNode | undefined {
        return this.operations.at(-1);
    }

    public getLatestOperationResultString(): string | undefined {
        const operation = this.getLatestOperation();
        if (operation?.sendResult) {
            return this.serializeTransactions(operation.sendResult.transactions);
        }
        return undefined;
    }

    public serializeTransactions(transactions: BlockchainTransaction[]): string {
        const fieldsToSave = ['blockchainLogs', 'vmLogs', 'debugLogs', 'shard', 'delay', 'totalDelay'];
        const dump = {
            transactions: transactions.map((t) => {
                const tx = beginCell()
                    .store(storeTransaction(t as Transaction))
                    .endCell()
                    .toBoc()
                    .toString('hex');

                const address = bigintToAddress(t.address);
                const contract = this.contracts.get(address?.toString() ?? '');

                return {
                    transaction: tx,
                    fields: fieldsToSave.reduce((acc: object, f) => {
                        // @ts-ignore
                        acc[f] = t[f];
                        return acc;
                    }, {}),
                    code: contract?.init?.code?.toBoc().toString('hex'),
                    sourceMap: contract?.sourceMap,
                    contractName: contract?.name,
                    parentId: t.parent?.lt.toString(),
                    childrenIds: t.children?.map((c) => c?.lt?.toString()),
                };
            }),
        };
        return JSON.stringify(dump, null, 2);
    }
}

const app = express();
app.use(express.json({ limit: '10mb' }));

let daemon: SandboxDaemon;

const initDaemon = async () => {
    daemon = await SandboxDaemon.create();
    console.log('Sandbox daemon initialized');
};

app.post('/deploy', async (req, res) => {
    try {
        const { stateInit, value, name, sourceMap, abi, sourceUri }: DeployRequest = req.body;

        if (!stateInit?.code || !stateInit?.data) {
            return res.status(400).json({ error: 'Missing stateInit.code or stateInit.data' });
        }

        const init: StateInit = {
            code: Cell.fromBase64(stateInit.code),
            data: Cell.fromBase64(stateInit.data),
        };

        const result = await daemon.deployContract(name, init, BigInt(value), sourceMap, abi, sourceUri);
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
        const { address, message }: SendExternalMessageRequest = req.body;

        if (!address || !message) {
            return res.status(400).json({ error: 'Missing address or message' });
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
        const { fromAddress, toAddress, message, sendMode, value }: SendInternalMessageRequest = req.body;

        if (!fromAddress || !toAddress || !message) {
            return res.status(400).json({ error: 'Missing fromAddress, toAddress or message' });
        }

        const messageCell = Cell.fromBase64(message);
        const valueAmount = BigInt(value);

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
        const { address, methodId, parameters }: GetMethodRequest = req.body;

        if (!address || methodId === undefined) {
            return res.status(400).json({ error: 'Missing address or methodId' });
        }

        const result = await daemon.callGetMethod(address, methodId, parameters);
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
        const { address }: InfoMethodRequest = req.body;

        if (!address) {
            return res.status(400).json({ error: 'Missing address' });
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

app.post('/rename-contract', async (req, res) => {
    try {
        const { address, newName }: RenameContractRequest = req.body;

        if (!address || !newName) {
            return res.status(400).json({ error: 'Missing address or newName' });
        }

        const result = await daemon.renameContract(address, newName);
        res.json(result);
    } catch (error) {
        console.error('Rename contract endpoint error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/contracts', async (_req, res) => {
    try {
        const result: ApiResponse<GetContractsServerData> = {
            success: true,
            data: {
                contracts: daemon.getDeployedContracts(),
            },
        };
        res.json(result);
    } catch (error) {
        console.error('Get contracts error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.delete('/contracts/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!address) {
            return res.status(400).json({
                error: 'Contract address is required',
            });
        }

        const removed = daemon.removeContract(address);

        if (!removed) {
            return res.status(404).json({
                error: 'Contract not found or cannot be removed',
            });
        }

        res.json({
            success: true,
            message: 'Contract removed successfully',
        });
    } catch (error) {
        console.error('Delete contract error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/operations', async (_req, res) => {
    try {
        const operationsWithResults = daemon.operations.map((operation) => ({
            ...operation,
            resultString: operation.sendResult
                ? daemon.serializeTransactions(operation.sendResult.transactions)
                : undefined,
            sendResult: undefined,
        }));
        const response: GetOperationsServerData = {operations: operationsWithResults};
        res.json(response);
    } catch (error) {
        console.error('Get operations error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/operations/latest/result', async (req, res) => {
    try {
        const operationResponse = daemon.getLatestOperation();
        if (!operationResponse) {
            return res.status(404).json({ error: 'No operations found' });
        }

        const resultString = daemon.getLatestOperationResultString();

        res.json({
            operation: {
                ...operationResponse,
                resultString,
                sendResult: undefined, // Remove sendResult for a client
            },
        });
    } catch (error) {
        console.error('Get latest operation result error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/restore-state', async (req, res) => {
    try {
        const { eventId } = req.body as { eventId: string };

        if (!eventId) {
            return res.status(400).json({
                error: 'eventId is required',
            });
        }

        const eventIndex = daemon.operations.findIndex((op) => op.id === eventId);
        if (eventIndex === -1) {
            return res.status(404).json({
                error: 'Event not found',
            });
        }

        let snapshotToLoad: BlockchainDaemonSnapshot | undefined = undefined;
        let snapshotSource = '';

        for (let i = eventIndex - 1; i >= 0; i--) {
            const op = daemon.operations[i];
            if (op.success && daemon.snapshots.has(op.id)) {
                snapshotToLoad = daemon.snapshots.get(op.id);
                snapshotSource = `operation ${op.id}`;
                break;
            }
        }

        if (!snapshotToLoad && daemon.snapshots.has('initial')) {
            snapshotToLoad = daemon.snapshots.get('initial');
            snapshotSource = 'initial state';
        }

        if (snapshotToLoad) {
            daemon.blockchain.loadFrom(snapshotToLoad.blockchain);
            daemon.contracts = new Map(snapshotToLoad.contracts);
            daemon.contractInfos = new Map(snapshotToLoad.contractInfos);
            daemon.operations = [...snapshotToLoad.operations];
            console.log(`Restored full daemon state from ${snapshotSource}`);
        } else {
            console.warn(`No snapshot found to restore state before event ${eventId}`);
        }

        console.log(`Restored state to before event ${eventId}`);

        res.json({ success: true });
    } catch (error) {
        console.error('Restore state error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

// Message Template endpoints
app.post('/message-templates', async (req, res) => {
    try {
        const templateData: CreateTemplateRequest = req.body;
        if (!templateData.name || !templateData.messageFields) {
            return res.status(400).json({ error: 'Missing required fields: name, opcode, messageFields, sendMode' });
        }

        const template = daemon.createMessageTemplate(templateData);
        res.json(template);
    } catch (error) {
        console.error('Create template error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/message-templates', async (_req, res) => {
    try {
        const templates = daemon.getMessageTemplates();
        res.json(templates);
    } catch (error) {
        console.error('Get templates error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.delete('/message-templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const success = daemon.deleteMessageTemplate(id);
        if (!success) {
            return res.status(404).json({ error: 'Template not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Delete template error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/health', (_req: unknown, res: { json: (arg0: { status: string; timestamp: string }) => void }) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
        console.log(`  POST /rename-contract - Rename contract`);
        console.log(`  GET /contracts - Get deployed contracts`);
        console.log(`  GET /operations - Get operation history`);
        console.log(`  GET /operations/latest/result - Get latest operation result`);
        console.log(`  POST /message-templates - Create message template`);
        console.log(`  GET /message-templates - Get all message templates`);
        console.log(`  DELETE /message-templates/:id - Delete message template`);
        console.log(`  GET /health - Health check`);
    });
};

if (require.main === module) {
    startServer().catch(console.error);
}

export { SandboxDaemon };
