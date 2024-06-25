import { ClientResponse, CustomerInteraction, CustomerOrderInteraction } from './customerInteraction.js';
import { Message } from '../message.js';
import { HKKAZ, HKKAZSegment } from '../segments/HKKAZ.js';
import { HIKAZ, HIKAZSegment } from '../segments/HIKAZ.js';
import { Mt940Parser, Statement } from '../mt940parser.js';
import { Segment } from '../segment.js';
import { FinTSConfig } from '../config.js';

export interface StatementResponse extends ClientResponse {
  statements: Statement[];
}

export class StatementInteraction extends CustomerOrderInteraction {
  constructor(public accountNumber: string, public from?: Date, public to?: Date) {
    super(HKKAZ.Id, HIKAZ.Id);
  }

  createSegments(init: FinTSConfig): Segment[] {
    const bankAccount = init.getBankAccount(this.accountNumber);
    if (!init.isAccountTransactionSupported(this.accountNumber, this.segId)) {
      throw Error(`Account ${this.accountNumber} does not support business transaction '${this.segId}'`);
    }

    const account = { ...bankAccount, iban: undefined };

    const version = init.getMaxSupportedTransactionVersion(HKKAZ.Id);

    if (!version) {
      throw Error(`There is no supported version for business transaction '${HKKAZ.Id}`);
    }

    const hkkaz: HKKAZSegment = {
      header: { segId: HKKAZ.Id, segNr: 0, version: version },
      account,
      allAccounts: false,
      from: this.from,
      to: this.to,
    };

    return [hkkaz];
  }

  handleResponse(response: Message, clientResponse: StatementResponse) {
    const hikaz = response.findSegment<HIKAZSegment>(HIKAZ.Id);
    if (hikaz) {
      const parser = new Mt940Parser(hikaz.bookedTransactions);
      clientResponse.statements = parser.parse();
    } else {
      clientResponse.statements = [];
    }
  }
}
