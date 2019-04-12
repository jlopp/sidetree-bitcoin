import { InMemoryTransactionStore } from './TransactionStore';
import Transaction from './Transaction';
import RequestHandler from './RequestHandler';
import { ResponseStatus } from './Response';

/**
 * The core class that is instantiated when running a Sidetree blockchain service.
 */
export default class BlockchainService {

  /**
   * request handler for non-fetch related APIs.
   */
  public requestHandler: RequestHandler;

  /**
   * Denotes if the periodic transaction processing should continue to occur.
   * Used mainly for test purposes.
   */
  private continuePeriodicProcessing = false;

  /**
   * Data store that stores the state of transactions.
   */
  private transactionStore = new InMemoryTransactionStore();
  private lastKnownTransaction: Transaction | undefined;

  /**
   * @param bitcoreSidetreeServiceUri URI for the blockchain service
   * @param sidetreeTransactionPrefix prefix used to identify Sidetree transactions in Bitcoin's blockchain
   * @param genesisTransactionNumber the first Sidetree transaction number in Bitcoin's blockchain
   * @param genesisTimeHash the corresponding timehash of genesis transaction number
   * @param pollingIntervalInSeconds time interval for the background task on polling Bitcoin blockchain
   */
  public constructor(public bitcoreSidetreeServiceUri: string,
    public sidetreeTransactionPrefix: string,
    public genesisTransactionNumber: number,
    public genesisTimeHash: string,
    private pollingIntervalInSeconds: number) {
    this.requestHandler = new RequestHandler(bitcoreSidetreeServiceUri, sidetreeTransactionPrefix, genesisTransactionNumber, genesisTimeHash);

  }

  /**
   * The initialization method that must be called before consumption of this object.
   * The method starts a background thread to fetch Sidetree transactions from the blockchain layer.
   */
  public async initialize () {
    await this.startPeriodicProcessing();
  }

  /**
   * The function that starts the periodic polling of Sidetree operations.
   */
  public async startPeriodicProcessing () {
    // Initialize the last known transaction before starting processing.
    this.lastKnownTransaction = await this.transactionStore.getLastTransaction();

    console.info(`Starting periodic transactions polling.`);
    setImmediate(async () => {
      this.continuePeriodicProcessing = true;

      // tslint:disable-next-line:no-floating-promises - this.processTransactions() never throws.
      this.processTransactions();
    });
  }

  /**
   * Stops periodic transaction processing.
   * Mainly used for test purposes.
   */
  public stopPeriodicProcessing () {
    console.info(`Stopped periodic transactions polling.`);
    this.continuePeriodicProcessing = false;
  }

  /**
   * Processes new transactions if any,
   * then scehdules the next round of processing using the following rules unless `stopPeriodicProcessing()` is invoked.
   */
  public async processTransactions () {
    let blockReorganizationDetected = false;
    try {
      // Keep fetching new Sidetree transactions from blockchain
      // until there are no more new transactions or there is a block reorganization.
      let moreTransactions = false;
      do {
        // Get the last transaction to be used as a timestamp to fetch new transactions.
        const lastKnownTransactionNumber = this.lastKnownTransaction ? this.lastKnownTransaction.transactionNumber : undefined;
        const lastKnownTransactionTimeHash = this.lastKnownTransaction ? this.lastKnownTransaction.transactionTimeHash : undefined;

        let readResult;
        try {
          console.info('Fetching Sidetree transactions from blockchain service...');
          readResult = await this.requestHandler.handleFetchRequest(lastKnownTransactionNumber, lastKnownTransactionTimeHash);

          // check if the request succeeded; if yes, process transactions
          if (readResult.status === ResponseStatus.Succeeded) {
            const readResultBody = readResult.body as any;
            const transactions = readResultBody['transactions'];
            moreTransactions = readResultBody['moreTransactions'];
            if (transactions.length > 0) {
              console.info(`Fetched ${transactions.length} Sidetree transactions from blockchain service ${transactions[0].transactionNumber}`);
            }

            for (const transaction of transactions) {
              await this.transactionStore.addTransaction(transaction);
              this.lastKnownTransaction = await this.transactionStore.getLastTransaction();
            }
          } else if (readResult.status === ResponseStatus.BadRequest) {
            const readResultBody = readResult.body as any;
            const code = readResultBody['code'];
            if (code === 'invalid_transaction_number_or_time_hash') {
              blockReorganizationDetected = true;
            }
          }
        } catch (error) {
          throw error;
        }

        // If block reorg is detected, revert invalid transactions
        if (blockReorganizationDetected) {
          console.info(`Block reorganization detected.`);

          console.info(`Reverting invalid transactions...`);
          await this.RevertInvalidTransactions();
          console.info(`Completed reverting invalid transactions.`);
        }
      } while (moreTransactions);
    } catch (error) {
      console.error(`Encountered unhandled and possibly fatal error, must investigate and fix:`);
      console.error(error);
    } finally {
      if (this.continuePeriodicProcessing) {
        console.info(`Waiting for ${this.pollingIntervalInSeconds} seconds before fetching and processing transactions again.`);
        setTimeout(async () => this.processTransactions(), this.pollingIntervalInSeconds * 1000);
      }
    }
  }

  /**
   * Reverts invalid transactions. Used in the event of a block-reorganization.
   */
  private async RevertInvalidTransactions () {
    // Compute a list of exponentially-spaced transactions with their index, starting from the last transaction of the processed transactions.
    const exponentiallySpacedTransactions = await this.transactionStore.getExponentiallySpacedTransactions();

    let transactionList = [];
    for (let i = 0; i < exponentiallySpacedTransactions.length; i++) {
      const transaction = exponentiallySpacedTransactions[i];
      transactionList.push({
        'transactionNumber': transaction.transactionNumber,
        'transactionTime': transaction.transactionTime,
        'transactionTimeHash': transaction.transactionTimeHash,
        'anchorFileHash': transaction.anchorFileHash
      });
    }

    const firstValidRequest = {
      'transactions': transactionList
    };

    // Find a known valid Sidetree transaction that is prior to the block reorganization.
    const bestKnownValidRecentTransaction
      = await this.requestHandler.handleFirstValidRequest(Buffer.from(JSON.stringify(firstValidRequest)));

    if (bestKnownValidRecentTransaction.status === ResponseStatus.Succeeded) {
      const bestKnownValidRecentTransactionBody = bestKnownValidRecentTransaction.body as any;
      const bestKnownValidRecentTransactionNumber = bestKnownValidRecentTransactionBody['transactionNumber'];
      console.info(`Best known valid recent transaction: ${bestKnownValidRecentTransactionNumber}`);
      await this.transactionStore.removeTransactionsLaterThan(bestKnownValidRecentTransactionNumber);

      // Reset the in-memory last known good Tranaction so we next processing cycle will fetch from the correct timestamp/maker.
      this.lastKnownTransaction = bestKnownValidRecentTransactionBody;
    }
  }
}
