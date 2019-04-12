import SortedArray from './lib/SortedArray';
import Transaction from './Transaction';

/**
 * An abstraction for the caching transactions that have been found on the blockchain.
 */
export interface TransactionStore {

  /**
   * Idempotent method that adds the given transaction to the list of transactions.
   */
  addTransaction (transaction: Transaction): Promise<void>;

  /**
   * Gets the most recent transaction. Returns undefined if there is no transaction.
   */
  getLastTransaction (): Promise<Transaction | undefined>;

  /**
   * Gets a list of exponentially-spaced processed transactions in reverse direction of the list of processed transactions
   * where the first element in the returned list is the last transaction in the list of processed transactions.
   */
  getExponentiallySpacedTransactions (): Promise<Transaction[]>;

  /**
   * Remove all transactions with transaction number greater than the provided parameter.
   * If `undefined` is given, remove all transactions.
   */
  removeTransactionsLaterThan (transactionNumber?: number): Promise<void>;
}

/**
 * In-memory implementation of the `TransactionStore`.
 */
export class InMemoryTransactionStore implements TransactionStore {
  private transactions: Transaction[] = [];

  async addTransaction (transaction: Transaction): Promise<void> {
    const lastTransaction = await this.getLastTransaction();

    // If the last transaction is later or equal to the transaction to add,
    // then we know this is a transaction previously processed, so no need to add it again.
    if (lastTransaction && lastTransaction.transactionNumber >= transaction.transactionNumber) {
      return;
    }

    this.transactions.push(transaction);
  }

  async getLastTransaction (): Promise<Transaction | undefined> {
    if (this.transactions.length === 0) {
      return undefined;
    }

    const lastTransactionIndex = this.transactions.length - 1;
    const lastTransaction = this.transactions[lastTransactionIndex];
    return lastTransaction;
  }

  async getExponentiallySpacedTransactions (): Promise<Transaction[]> {
    const exponentiallySpacedTransactions: Transaction[] = [];
    let index = this.transactions.length - 1;
    let distance = 1;
    while (index >= 0) {
      exponentiallySpacedTransactions.push(this.transactions[index]);
      index -= distance;
      distance *= 2;
    }
    return exponentiallySpacedTransactions;
  }
  async removeTransactionsLaterThan (transactionNumber?: number): Promise<void> {
    // If given `undefined`, remove all transactions.
    if (transactionNumber === undefined) {
      this.transactions = [];
      return;
    }

    // Locate the index of the given transaction using binary search.
    const compareTransactionAndTransactionNumber
      = (transaction: Transaction, transactionNumber: number) => { return transaction.transactionNumber - transactionNumber; };
    const bestKnownValidRecentTransactionIndex
      = SortedArray.binarySearch(this.transactions, transactionNumber, compareTransactionAndTransactionNumber);

    // The following conditions should never be possible.
    if (bestKnownValidRecentTransactionIndex === undefined) {
      throw Error(`Unable to locate transction: ${transactionNumber}`);
    }

    console.info(`Reverting ${this.transactions.length - bestKnownValidRecentTransactionIndex - 1} transactions...`);
    this.transactions.splice(bestKnownValidRecentTransactionIndex + 1);
  }
}
