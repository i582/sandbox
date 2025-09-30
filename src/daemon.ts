// @ts-nocheck

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
    toNano,
    Transaction,
    TupleReader,
} from '@ton/core';

import {Blockchain, BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract,} from '../src';
import {bigintToAddress} from './blockchain/web-ui-websocket';
import {TupleItem} from "@ton/core/src/tuple/tuple";

export type ExtendedGetResult = ContractGetMethodResult & { vmLogs: string };

interface DeployRequest {
    readonly stateInit: {
        readonly code: string; // base64
        readonly data: string; // base64
    };
    readonly value?: string; // nano TON amount
    readonly name?: string;
    readonly sourceMap?: object;
    readonly abi?: object;
    readonly sourceUri?: string; // URI of the source file
}

interface MessageTemplate {
    readonly id: string;
    readonly name: string;
    readonly opcode: number; // message opcode for filtering
    readonly messageBody: string; // Base64 encoded BoC
    readonly sendMode: number;
    readonly value?: string; // nano TON amount
    readonly createdAt: string; // ISO date string
    readonly description?: string;
}

interface CreateTemplateRequest {
    readonly name: string;
    readonly opcode: number;
    readonly messageBody: string; // Base64 encoded BoC
    readonly sendMode: number;
    readonly value?: string; // nano TON amount
    readonly description?: string;
}

interface UpdateTemplateRequest {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
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
    readonly parameters: string; // base64 encoded tuple parameters
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
    readonly opcode?: number;
}

interface OperationsResponse {
    readonly operations: OperationNode[];
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

    async getAny(provider: ContractProvider, id: number, parametersBase64: string): [TupleReader, string] {
        let parameters: TupleItem[] = [];

        try {
            const paramCell = Cell.fromBase64(parametersBase64);
            parameters = parseTuple(paramCell);
        } catch (error) {
            console.warn('Failed to parse parameters:', error);
        }

        console.log("Call get method with id", id, "and parameters:", parameters, "")
        const res = (await provider.get(id, parameters)) as ExtendedGetResult;
        return [res.stack, res.vmLogs];
    }
}

class SandboxDaemon {
    public blockchain: Blockchain;
    public treasury: SandboxContract<TreasuryContract>;
    public contracts: Map<string, SandboxContract<DaemonContract>> = new Map();
    public contractInfos: Map<string, { name?: string; sourceMap?: object; abi?: object; sourceUri?: string }> =
        new Map();
    public operations: OperationNode[] = [];
    public snapshots: Map<string, any> = new Map(); // operationId -> full daemon state snapshot
    public messageTemplates: Map<string, MessageTemplate> = new Map();

    constructor(blockchain: Blockchain, treasury: SandboxContract<TreasuryContract>) {
        this.blockchain = blockchain;
        this.treasury = treasury;

        // Add treasury info to contractInfos for proper name resolution
        this.contractInfos.set(treasury.address.toString(), {
            name: 'treasury',
            sourceMap: undefined,
            abi: undefined,
        });

        // Save initial daemon state snapshot
        try {
            const initialDaemonStateSnapshot = {
                blockchain: this.blockchain.snapshot(),
                contracts: new Map(this.contracts), // Initially empty
                contractInfos: new Map(this.contractInfos), // Only treasury info
                operations: [], // Initially empty
            };
            this.snapshots.set('initial', initialDaemonStateSnapshot);
            console.log('Saved initial daemon state snapshot');
        } catch (error) {
            console.warn('Failed to save initial snapshot:', error);
        }
    }

    private addOperation(operation: Omit<OperationNode, 'id' | 'timestamp'>): void {
        const newOperation: OperationNode = {
            id: `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            ...operation,
        };

        // Save full daemon state snapshot before this operation
        if (operation.success) {
            try {
                const daemonStateSnapshot = {
                    blockchain: this.blockchain.snapshot(),
                    contracts: new Map(this.contracts), // Clone the contracts map
                    contractInfos: new Map(this.contractInfos), // Clone the contractInfos map
                    operations: [...this.operations], // Clone the operations array
                };
                this.snapshots.set(newOperation.id, daemonStateSnapshot);
                console.log(`Saved full daemon state snapshot for operation ${newOperation.id}`);
            } catch (error) {
                console.warn(`Failed to save snapshot for operation ${newOperation.id}:`, error);
            }
        }

        this.operations.push(newOperation); // Добавляем в конец массива (старые операции сверху)
    }

    static async create(): Promise<SandboxDaemon> {
        const blockchain = await Blockchain.create({webUI: true});
        blockchain.verbosity.print = false;
        blockchain.verbosity.vmLogs = 'vm_logs_verbose';

        const treasury = await blockchain.treasury('treasury');

        return new SandboxDaemon(blockchain, treasury);
    }

    async deployContract(
        name: string,
        stateInit: StateInit,
        valueAmount: bigint,
        sourceMap: object | undefined,
        abi: object | undefined,
        sourceUri?: string,
    ): Promise<{
        address: string;
        success: boolean;
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
                abi: abi,
                sourceUri: sourceUri,
            });

            // Add operation to history
            this.addOperation({
                type: 'deploy',
                contractName: name,
                contractAddress: address.toString(),
                details: `Deployed ${name} with initial value`,
                success: true,
            });

            return {
                address: address.toString(),
                success: true,
            };
        } catch (error) {
            console.error('Deploy error:', error);

            // Add failed operation to history
            this.addOperation({
                type: 'deploy',
                contractName: name,
                details: `Failed to deploy ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                success: false,
            });

            return {
                address: '',
                success: false,
            };
        }
    }

    /**
     * Send external message from treasury to contract
     */
    async sendExternalMessage(
        address: string,
        message: Cell,
    ): Promise<{
        success: boolean;
        txs?: {
            addr?: string;
            vmLogs?: string;
            code?: string;
            mapping?: object;
        }[];
        error?: string;
    }> {
        // Try to extract opcode from message
        let opcode: number | undefined;
        try {
            const slice = message.beginParse();
            if (slice.remainingBits >= 32) {
                opcode = slice.loadUint(32);
            }
        } catch {
            // Ignore if we can't parse opcode
        }

        try {
            const contract = this.contracts.get(address);
            if (!contract) {
                return {success: false, error: 'Contract not found'};
            }

            const result = await this.blockchain.sendMessage(
                external({
                    to: contract.address,
                    body: message,
                }),
            );

            // Add operation to history
            const contractInfo = this.contractInfos.get(address);
            this.addOperation({
                type: 'send-external',
                contractName: contractInfo?.name,
                contractAddress: address,
                details: `External message sent to ${contractInfo?.name || address}`,
                success: true,
                sendResult: result,
                opcode,
            });

            return {
                success: true,
                txs: result.transactions.slice(1).map((tx) => {
                    const addr = (tx.inMessage?.info.dest as Address).toString();
                    const code = (this.contracts.get(addr)?.init?.code ?? new Cell()).toBoc().toString('hex');
                    return {
                        addr: addr,
                        vmLogs: tx.vmLogs,
                        code: code,
                        sourceMap: this.contracts.get(addr)?.sourceMap,
                    };
                }),
            };
        } catch (error) {
            console.error('Send message error:', error);

            // Add failed operation to history
            const contractInfo = this.contractInfos.get(address);
            this.addOperation({
                type: 'send-external',
                contractName: contractInfo?.name,
                contractAddress: address,
                details: `Failed to send external message to ${contractInfo?.name || address}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                success: false,
                opcode,
            });

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async callGetMethod(
        address: string,
        methodId: number,
        parametersBase64: string,
    ): Promise<{
        success: boolean;
        result?: string;
        logs?: string;
        error?: string;
    }> {
        try {
            const contract = this.contracts.get(address);
            if (!contract) {
                return {success: false, error: 'Contract not found'};
            }

            const [stack, logs] = await contract.getAny(methodId, parametersBase64);

            return {
                success: true,
                result: serializeTuple(stack.items as TupleItem[]).toBoc().toString('base64'),
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

    getDeployedContracts(): Array<{
        address: string;
        name?: string;
        sourceMap?: object;
        abi?: object;
        sourceUri?: string;
    }> {
        const contracts = Array.from(this.contracts.entries()).map(([address]) => {
            const info = this.contractInfos.get(address);
            return {
                address,
                name: info?.name,
                sourceMap: info?.sourceMap,
                abi: info?.abi,
                sourceUri: info?.sourceUri,
            };
        });

        // Add treasury contract to the list
        contracts.unshift({
            address: this.treasury.address.toString(),
            name: 'treasury',
            sourceMap: undefined,
            abi: undefined,
            sourceUri: undefined,
        });

        return contracts;
    }

    removeContract(address: string): boolean {
        // Don't allow removing treasury contract
        if (address === this.treasury.address.toString()) {
            return false;
        }

        const hadContract = this.contracts.has(address);
        const hadInfo = this.contractInfos.has(address);

        if (hadContract) {
            this.contracts.delete(address);
        }

        if (hadInfo) {
            this.contractInfos.delete(address);
        }

        return hadContract || hadInfo;
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
            sourceUri?: string;
        };
        error?: string;
    }> {
        try {
            // Check if it's treasury
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
                    result: {
                        account: accountCell.toBoc().toString('hex'),
                        stateInit,
                        abi: undefined, // Treasury doesn't have ABI
                        sourceUri: undefined, // Treasury doesn't have source file
                    },
                };
            }

            const contract = this.contracts.get(address);
            if (!contract) {
                return {success: false, error: 'Contract not found'};
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
            const abi = contractInfo?.abi;
            const sourceUri = contractInfo?.sourceUri;

            return {
                success: true,
                result: {
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

    async renameContract(
        address: string,
        newName: string,
    ): Promise<{
        success: boolean;
        error?: string;
    }> {
        try {
            const contractInfo = this.contractInfos.get(address);
            if (!contractInfo) {
                return {success: false, error: 'Contract not found'};
            }

            contractInfo.name = newName;

            console.log(`Renamed contract ${address} to "${newName}"`);

            return {
                success: true,
            };
        } catch (error) {
            console.error('Rename contract error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    // Message Template methods
    createMessageTemplate(templateData: Omit<MessageTemplate, 'id' | 'createdAt'>): MessageTemplate {
        const id = `template_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const template: MessageTemplate = {
            id,
            name: templateData.name,
            opcode: templateData.opcode,
            messageBody: templateData.messageBody,
            sendMode: templateData.sendMode,
            value: templateData.value,
            description: templateData.description,
            createdAt: new Date().toISOString(),
        };
        this.messageTemplates.set(id, template);
        console.log(`Created message template: ${template.name} (${id})`);
        return template;
    }

    getMessageTemplates(): MessageTemplate[] {
        return Array.from(this.messageTemplates.values());
    }

    getMessageTemplate(id: string): MessageTemplate | undefined {
        return this.messageTemplates.get(id);
    }

    updateMessageTemplate(id: string, updates: Partial<Pick<MessageTemplate, 'name' | 'description'>>): boolean {
        const template = this.messageTemplates.get(id);
        if (!template) return false;

        const updatedTemplate = {...template, ...updates};
        this.messageTemplates.set(id, updatedTemplate);
        console.log(`Updated message template: ${updatedTemplate.name} (${id})`);
        return true;
    }

    deleteMessageTemplate(id: string): boolean {
        const deleted = this.messageTemplates.delete(id);
        if (deleted) {
            console.log(`Deleted message template: ${id}`);
        }
        return deleted;
    }

    async sendInternalMessage(
        fromAddress: string,
        toAddress: string,
        message: Cell,
        sendMode: number,
        value: bigint = toNano('1'),
    ): Promise<{
        success: boolean;
        txs?: {
            addr?: string;
            vmLogs?: string;
            code?: string;
            sourceMap?: object;
        }[];
        error?: string;
    }> {
        // Try to extract opcode from message
        let opcode: number | undefined;
        try {
            const slice = message.beginParse();
            if (slice.remainingBits >= 32) {
                opcode = slice.loadUint(32);
            }
        } catch {
            // Ignore if we can't parse opcode
        }

        try {
            const fromContract =
                fromAddress === this.treasury.address.toString() ? this.treasury : this.contracts.get(fromAddress);
            if (!fromContract) {
                return {success: false, error: 'From contract not found'};
            }

            const toContract = this.contracts.get(toAddress);
            if (!toContract) {
                return {success: false, error: 'To contract not found'};
            }

            const fromContractSender = this.blockchain.sender(fromContract.address);

            const result = await toContract.send(fromContractSender, {value, bounce: false}, message, sendMode);

            const fromContractInfo = this.contractInfos.get(fromAddress);
            const toContractInfo = this.contractInfos.get(toAddress);
            this.addOperation({
                type: 'send-internal',
                fromContract: fromAddress,
                toContract: toAddress,
                success: true,
                sendResult: result,
                opcode,
            });

            return {
                success: true,
                txs: result.transactions.slice(0, -1).map((tx) => {
                    const addr = (tx.inMessage?.info.dest as Address).toString();
                    const code = (this.contracts.get(addr)?.init?.code ?? new Cell()).toBoc().toString('hex');
                    return {
                        addr: addr,
                        vmLogs: tx.vmLogs,
                        code: code,
                        sourceMap: this.contracts.get(addr)?.sourceMap,
                    };
                }),
            };
        } catch (error) {
            console.error('Send internal message error:', error);

            const fromContractInfo = this.contractInfos.get(fromAddress);
            const toContractInfo = this.contractInfos.get(toAddress);
            this.addOperation({
                type: 'send-internal',
                fromContract: fromAddress,
                toContract: toAddress,
                details: error instanceof Error ? error.message : 'Unknown error',
                success: false,
                opcode,
            });

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
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
                    fields: fieldsToSave.reduce((acc: any, f) => {
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
app.use(express.json({limit: '10mb'}));

let daemon: SandboxDaemon;

const initDaemon = async () => {
    daemon = await SandboxDaemon.create();
    console.log('Sandbox daemon initialized');
};

app.post('/deploy', async (req, res) => {
    try {
        const {stateInit, value, name, sourceMap, abi, sourceUri}: DeployRequest = req.body;

        if (!stateInit?.code || !stateInit?.data) {
            return res.status(400).json({error: 'Missing stateInit.code or stateInit.data'});
        }

        const valueAmount = value ? toNano(value) : toNano('1');

        const init: StateInit = {
            code: Cell.fromBase64(stateInit.code),
            data: Cell.fromBase64(stateInit.data),
        };

        const result = await daemon.deployContract(
            name ?? 'UnknownContract',
            init,
            valueAmount,
            sourceMap,
            abi,
            sourceUri,
        );
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
        const valueAmount = value ? toNano(value) : toNano('1');

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
        const {address, methodId, parameters}: GetMethodRequest = req.body;

        if (!address || methodId === undefined) {
            return res.status(400).json({error: 'Missing address or methodId'});
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

app.post('/rename-contract', async (req, res) => {
    try {
        const {address, newName}: RenameContractRequest = req.body;

        if (!address || !newName) {
            return res.status(400).json({error: 'Missing address or newName'});
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
        const deployedContracts = daemon.getDeployedContracts();
        const contracts = deployedContracts.map(({address, name, sourceMap, abi, sourceUri}) => ({
            address,
            name: name ?? 'Unknown',
            sourceMap,
            abi,
            sourceUri,
        }));
        res.json({contracts});
    } catch (error) {
        console.error('Get contracts error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.delete('/contracts/:address', async (req, res) => {
    try {
        const {address} = req.params;

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
        const response: OperationsResponse = {operations: operationsWithResults};
        res.json(response);
    } catch (error) {
        console.error('Get operations error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/restore-state', async (req, res) => {
    try {
        const {eventId} = req.body as { eventId: string };

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

        // Find the previous successful operation that has a snapshot
        let snapshotToLoad: any = null;
        let snapshotSource = '';

        for (let i = eventIndex - 1; i >= 0; i--) {
            const op = daemon.operations[i];
            if (op.success && daemon.snapshots.has(op.id)) {
                snapshotToLoad = daemon.snapshots.get(op.id);
                snapshotSource = `operation ${op.id}`;
                break;
            }
        }

        // If no previous operation snapshot found, use initial snapshot
        if (!snapshotToLoad && daemon.snapshots.has('initial')) {
            snapshotToLoad = daemon.snapshots.get('initial');
            snapshotSource = 'initial state';
        }

        if (snapshotToLoad) {
            // Restore full daemon state from snapshot
            daemon.blockchain.loadFrom(snapshotToLoad.blockchain);
            daemon.contracts = new Map(snapshotToLoad.contracts);
            daemon.contractInfos = new Map(snapshotToLoad.contractInfos);
            daemon.operations = [...snapshotToLoad.operations];
            console.log(`Restored full daemon state from ${snapshotSource}`);
        } else {
            console.warn(`No snapshot found to restore state before event ${eventId}`);
        }

        // Note: Operations are already restored from snapshot, no need to manually splice

        console.log(`Restored state to before event ${eventId}`);

        res.json({success: true});
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
        if (
            !templateData.name ||
            typeof templateData.opcode !== 'number' ||
            !templateData.messageBody ||
            typeof templateData.sendMode !== 'number'
        ) {
            return res.status(400).json({error: 'Missing required fields: name, opcode, messageBody, sendMode'});
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
        res.json({templates});
    } catch (error) {
        console.error('Get templates error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/message-templates/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const template = daemon.getMessageTemplate(id);
        if (!template) {
            return res.status(404).json({error: 'Template not found'});
        }
        res.json(template);
    } catch (error) {
        console.error('Get template error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.put('/message-templates/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const updates: UpdateTemplateRequest = req.body;
        const success = daemon.updateMessageTemplate(id, updates);
        if (!success) {
            return res.status(404).json({error: 'Template not found'});
        }
        res.json({success: true});
    } catch (error) {
        console.error('Update template error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.delete('/message-templates/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const success = daemon.deleteMessageTemplate(id);
        if (!success) {
            return res.status(404).json({error: 'Template not found'});
        }
        res.json({success: true});
    } catch (error) {
        console.error('Delete template error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/health', (_req: any, res: { json: (arg0: { status: string; timestamp: string }) => void }) => {
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
        console.log(`  POST /rename-contract - Rename contract`);
        console.log(`  GET /contracts - Get deployed contracts`);
        console.log(`  GET /operations - Get operation history`);
        console.log(`  POST /message-templates - Create message template`);
        console.log(`  GET /message-templates - Get all message templates`);
        console.log(`  GET /message-templates/:id - Get message template by ID`);
        console.log(`  PUT /message-templates/:id - Update message template`);
        console.log(`  DELETE /message-templates/:id - Delete message template`);
        console.log(`  GET /health - Health check`);
    });
};

if (require.main === module) {
    startServer().catch(console.error);
}

export {SandboxDaemon};
