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

enum LogLevel {
    TRACE = 0,
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4,
    FATAL = 5,
}

interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    context?: Record<string, any>;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
}

class Logger {
    private static instance: Logger;
    private readonly currentLevel: LogLevel;
    private readonly isJsonFormat: boolean;

    private constructor() {
        const logLevel = process.env.LOG_LEVEL ?? 'INFO';
        this.currentLevel = LogLevel[logLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
        this.isJsonFormat = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private shouldLog(level: LogLevel): boolean {
        return level >= this.currentLevel;
    }

    private formatLogEntry(entry: LogEntry): string {
        if (this.isJsonFormat) {
            return JSON.stringify(entry);
        }

        const timestamp = new Date(entry.timestamp).toISOString();
        let logLine = `[${timestamp}] ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`;

        if (entry.context && Object.keys(entry.context).length > 0) {
            logLine += ` ${JSON.stringify(entry.context)}`;
        }

        if (entry.error) {
            logLine += `\n  Error: ${entry.error.message}`;
            if (entry.error.stack) {
                logLine += `\n  Stack: ${entry.error.stack}`;
            }
        }

        return logLine;
    }

    private log(
        level: LogLevel,
        levelName: string,
        message: string,
        context?: Record<string, any>,
        error?: Error,
    ): void {
        if (!this.shouldLog(level)) {
            return;
        }

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: levelName,
            message,
            context,
        };

        if (error) {
            entry.error = {
                name: error.name,
                message: error.message,
                stack: error.stack,
            };
        }

        const output = this.formatLogEntry(entry);

        switch (level) {
            case LogLevel.TRACE:
            case LogLevel.DEBUG:
            case LogLevel.INFO:
                console.log(output);
                break;
            case LogLevel.WARN:
                console.warn(output);
                break;
            case LogLevel.ERROR:
            case LogLevel.FATAL:
                console.error(output);
                break;
        }
    }

    public trace(message: string, context?: Record<string, any>): void {
        this.log(LogLevel.TRACE, 'trace', message, context);
    }

    public debug(message: string, context?: Record<string, any>): void {
        this.log(LogLevel.DEBUG, 'debug', message, context);
    }

    public info(message: string, context?: Record<string, any>): void {
        this.log(LogLevel.INFO, 'info', message, context);
    }

    public warn(message: string, context?: Record<string, any>, error?: Error): void {
        this.log(LogLevel.WARN, 'warn', message, context, error);
    }

    public error(message: string, context?: Record<string, any>, error?: Error): void {
        this.log(LogLevel.ERROR, 'error', message, context, error);
    }

    public fatal(message: string, context?: Record<string, any>, error?: Error): void {
        this.log(LogLevel.FATAL, 'fatal', message, context, error);
    }
}

const logger = Logger.getInstance();

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
            logger.warn('Failed to parse parameters', { methodId: id }, error as Error);
        }

        logger.debug('Call get method', { methodId: id, parameters });
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
            logger.info('Saved initial daemon state snapshot');
        } catch (error) {
            logger.warn('Failed to save initial snapshot', {}, error as Error);
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
                logger.info(`Saved full daemon state snapshot for operation ${newOperation.id}`, {
                    operationId: newOperation.id,
                });
            } catch (error) {
                logger.warn(
                    `Failed to save snapshot for operation ${newOperation.id}`,
                    { operationId: newOperation.id },
                    error as Error,
                );
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
            logger.error('Deploy error', { contractName: name }, error as Error);

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
            logger.error(
                'Send external message error',
                { address, contractName: this.contractInfos.get(address)?.name },
                error as Error,
            );

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
            logger.error('Send internal message error', { fromAddress, toAddress }, error as Error);

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
            logger.error('Get method error', { address, methodId }, error as Error);
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
                logger.warn(`Contract has no info`, { address });
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
            logger.error('Get info error', { address }, error as Error);
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

            logger.info(`Renamed contract`, { address, newName, oldName: contractInfo.name });

            return {
                success: true,
                data: {},
            };
        } catch (error) {
            logger.error('Rename contract error', { address, newName }, error as Error);
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
        logger.info(`Created message template`, { templateId: id, templateName: template.name });
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
            logger.info(`Deleted message template`, { templateId: id });
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
    logger.info('Sandbox daemon initialized');
};

app.post('/deploy', async (req, res) => {
    logger.trace('Deploy endpoint called', {
        endpoint: '/deploy',
        body: req.body,
    });

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
        logger.error('Deploy endpoint error', { endpoint: '/deploy' }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/send-external', async (req, res) => {
    const { address, message }: SendExternalMessageRequest = req.body;

    logger.trace('Send external endpoint called', {
        endpoint: '/send-external',
        address,
        messageLength: message?.length,
    });

    try {
        if (!address || !message) {
            return res.status(400).json({ error: 'Missing address or message' });
        }

        const messageCell = Cell.fromBase64(message);

        const result = await daemon.sendExternalMessage(address, messageCell);
        res.json(result);
    } catch (error) {
        logger.error('Send external endpoint error', { endpoint: '/send-external', address }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/send-internal', async (req, res) => {
    const { fromAddress, toAddress, message, sendMode, value }: SendInternalMessageRequest = req.body;

    logger.trace('Send internal endpoint called', {
        endpoint: '/send-internal',
        fromAddress,
        toAddress,
        sendMode,
        value,
        message,
    });

    try {
        if (!fromAddress || !toAddress || !message) {
            return res.status(400).json({ error: 'Missing fromAddress, toAddress or message' });
        }

        const messageCell = Cell.fromBase64(message);
        const valueAmount = BigInt(value);

        const result = await daemon.sendInternalMessage(fromAddress, toAddress, messageCell, sendMode, valueAmount);
        res.json(result);
    } catch (error) {
        logger.error(
            'Send internal endpoint error',
            { endpoint: '/send-internal', fromAddress, toAddress },
            error as Error,
        );
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/get', async (req, res) => {
    const { address, methodId, parameters }: GetMethodRequest = req.body;

    logger.trace('Get method endpoint called', {
        endpoint: '/get',
        address,
        methodId,
        parametersLength: parameters?.length,
    });

    try {
        if (!address || methodId === undefined) {
            return res.status(400).json({ error: 'Missing address or methodId' });
        }

        const result = await daemon.callGetMethod(address, methodId, parameters);
        res.json(result);
    } catch (error) {
        logger.error('Get endpoint error', { endpoint: '/get', address, methodId }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/info', async (req, res) => {
    const { address }: InfoMethodRequest = req.body;

    logger.trace('Info endpoint called', {
        endpoint: '/info',
        address,
    });

    try {
        if (!address) {
            return res.status(400).json({ error: 'Missing address' });
        }

        const result = await daemon.getInfo(address);
        res.json(result);
    } catch (error) {
        logger.error('Info endpoint error', { endpoint: '/info', address }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/rename-contract', async (req, res) => {
    const { address, newName }: RenameContractRequest = req.body;

    logger.trace('Rename contract endpoint called', {
        endpoint: '/rename-contract',
        address,
        newName,
    });

    try {
        if (!address || !newName) {
            return res.status(400).json({ error: 'Missing address or newName' });
        }

        const result = await daemon.renameContract(address, newName);
        res.json(result);
    } catch (error) {
        logger.error(
            'Rename contract endpoint error',
            { endpoint: '/rename-contract', address, newName },
            error as Error,
        );
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/contracts', async (req, res) => {
    logger.trace('Get contracts endpoint called', {
        endpoint: '/contracts',
    });

    try {
        const result: ApiResponse<GetContractsServerData> = {
            success: true,
            data: {
                contracts: daemon.getDeployedContracts(),
            },
        };
        res.json(result);
    } catch (error) {
        logger.error('Get contracts endpoint error', { endpoint: '/contracts' }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.delete('/contracts/:address', async (req, res) => {
    const { address } = req.params;

    logger.trace('Delete contract endpoint called', {
        endpoint: '/contracts/:address',
        address,
    });

    try {
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
        logger.error('Delete contract endpoint error', { endpoint: '/contracts/:address', address }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/operations', async (req, res) => {
    logger.trace('Get operations endpoint called', {
        endpoint: '/operations',
    });

    try {
        const operationsWithResults = daemon.operations.map((operation) => ({
            ...operation,
            resultString: operation.sendResult
                ? daemon.serializeTransactions(operation.sendResult.transactions)
                : undefined,
            sendResult: undefined,
        }));
        const response: GetOperationsServerData = { operations: operationsWithResults };
        res.json(response);
    } catch (error) {
        logger.error('Get operations endpoint error', { endpoint: '/operations' }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/operations/latest/result', async (req, res) => {
    logger.trace('Get latest operation result endpoint called', {
        endpoint: '/operations/latest/result',
    });

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
        logger.error(
            'Get latest operation result endpoint error',
            { endpoint: '/operations/latest/result' },
            error as Error,
        );
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.post('/restore-state', async (req, res) => {
    const { eventId } = req.body as { eventId: string };

    logger.trace('Restore state endpoint called', {
        endpoint: '/restore-state',
        eventId,
    });

    try {
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
            logger.info(`Restored full daemon state`, { snapshotSource, eventId });
        } else {
            logger.warn(`No snapshot found to restore state before event`, { eventId });
        }

        logger.info(`Restored state to before event`, { eventId });

        res.json({ success: true });
    } catch (error) {
        logger.error('Restore state endpoint error', { endpoint: '/restore-state', eventId }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

// Message Template endpoints
app.post('/message-templates', async (req, res) => {
    const templateData: CreateTemplateRequest = req.body;

    logger.trace('Create message template endpoint called', {
        endpoint: '/message-templates',
        name: templateData.name,
        messageFields: templateData.messageFields,
    });

    if (!templateData.name || !templateData.messageFields) {
        logger.error(
            'Create message template endpoint error: Missing required fields: name, opcode, messageFields, sendMode',
            { endpoint: '/message-templates' },
        );
        return res.status(400).json({ error: 'Missing required fields: name, opcode, messageFields, sendMode' });
    }

    try {
        const template = daemon.createMessageTemplate(templateData);
        res.json(template);
    } catch (error) {
        logger.error('Create message template endpoint error', { endpoint: '/message-templates' }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/message-templates', async (req, res) => {
    logger.trace('Get message templates endpoint called', {
        endpoint: '/message-templates',
    });

    try {
        const templates = daemon.getMessageTemplates();
        res.json(templates);
    } catch (error) {
        logger.error('Get message templates endpoint error', { endpoint: '/message-templates' }, error as Error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.delete('/message-templates/:id', async (req, res) => {
    const { id } = req.params;

    logger.trace('Delete message template endpoint called', {
        endpoint: '/message-templates/:id',
        templateId: id,
    });

    try {
        const success = daemon.deleteMessageTemplate(id);
        if (!success) {
            return res.status(404).json({ error: 'Template not found' });
        }
        res.json({ success: true });
    } catch (error) {
        logger.error(
            'Delete message template endpoint error',
            { endpoint: '/message-templates/:id', templateId: id },
            error as Error,
        );
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
});

app.get('/health', (req, res) => {
    logger.trace('Health endpoint called', {
        endpoint: '/health',
    });

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
    startServer().catch((error) => {
        logger.fatal('Failed to start server', {}, error as Error);
        process.exit(1);
    });
}

export { SandboxDaemon };
