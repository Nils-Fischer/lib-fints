import { ClientResponse, CustomerInteraction, CustomerOrderInteraction } from './customerInteraction.js';
import { Message } from '../message.js';
import { Segment } from '../segment.js';
import { FinTSConfig } from '../config.js';
import { HKIDN, HKIDNSegment } from '../segments/HKIDN.js';
import { BankMessage, BankingInformation } from '../bankingInformation.js';
import { HKVVB, HKVVBSegment } from '../segments/HKVVB.js';
import { Language, SyncMode } from '../codes.js';
import { HKSYN, HKSYNSegment } from '../segments/HKSYN.js';
import { HISYN, HISYNSegment } from '../segments/HISYN.js';
import { BankAnswer } from '../bankAnswer.js';
import { HIBPA, HIBPASegment } from '../segments/HIBPA.js';
import { HITANS, HITANSSegment, HitansTanMethod } from '../segments/HITANS.js';
import { TanMethod } from '../tanMethod.js';
import { HIKOM, HIKOMSegment } from '../segments/HIKOM.js';
import { HIPINS, HIPINSSegment } from '../segments/HIPINS.js';
import { BankTransaction } from '../bankTransaction.js';
import { HIUPA, HIUPASegment } from '../segments/HIUPA.js';
import { BankAccount, finTsAccountTypeToEnum } from '../bankAccount.js';
import { HIKIMSegment, HIKIM } from '../segments/HIKIM.js';
import { HIUPDSegment, HIUPD } from '../segments/HIUPD.js';

export interface InitResponse extends ClientResponse {
	bankingInformation?: BankingInformation;
}

export class InitDialogInteraction extends CustomerInteraction {
	constructor(
		public config: FinTSConfig,
		public syncSystemId = false,
		public followUpInteraction?: CustomerOrderInteraction
	) {
		super(HKIDN.Id);
	}

	createSegments(init: FinTSConfig): Segment[] {
		const segments = [];

		const hkidn: HKIDNSegment = {
			header: { segId: HKIDN.Id, segNr: 0, version: HKIDN.Version },
			bank: { country: init.countryCode, bankId: init.bankId },
			customerId: init.customerId ?? init.userId ?? '9999999999',
			systemId: init.bankingInformation.systemId,
			systemIdRequired: this.config.userId ? 1 : 0,
		};

		segments.push(hkidn);

		const hkvvb: HKVVBSegment = {
			header: { segId: HKVVB.Id, segNr: 0, version: HKVVB.Version },
			bpdVersion: init.bankingInformation.bpd?.version ?? 0,
			updVersion: init.bankingInformation.upd?.version ?? 0,
			dialogLanguage: Language.Default,
			productId: init.productId,
			productVersion: init.productVersion,
		};

		segments.push(hkvvb);

		if (this.syncSystemId && this.config.userId && init.bankingInformation.systemId === '0') {
			const hksyn: HKSYNSegment = {
				header: { segId: HKSYN.Id, segNr: 0, version: HKSYN.Version },
				mode: SyncMode.NewSystemId,
			};

			segments.push(hksyn);
		}

		return segments;
	}

	handleResponse(response: Message, clientResponse: InitResponse) {
		const currentBankingInformationSnapshot = JSON.stringify(this.config.bankingInformation);

		const hisyn = response.findSegment<HISYNSegment>(HISYN.Id);
		if (hisyn && hisyn.systemId) {
			this.config.bankingInformation.systemId = hisyn.systemId;
		}

		const bankAnswers: BankAnswer[] = clientResponse.bankAnswers;

		const hibpa = response.findSegment<HIBPASegment>(HIBPA.Id);

		if (hibpa) {
			const hitansSegments = response.findAllSegments<HITANSSegment>(HITANS.Id);
			const supportedTanMethods: TanMethod[] = [];
			hitansSegments.forEach((hitans) => {
				supportedTanMethods.push(
					...(hitans?.params.tanMethods.map((method) => ({
						id: method.secFunc,
						name: method.methodName,
						version: hitans.header.version,
						isDecoupled: isDecoupledTanMethod(method),
						activeTanMediaCount: method.activeTanMedia,
						activeTanMedia: [],
						tanMediaRequirement: method.tanMediaRequired,
						decoupled: isDecoupledTanMethod(method)
							? {
									maxStatusRequests: method.decoupledMaxStatusRequests!,
									waitingSecondsBeforeFirstStatusRequest: method.decoupledWaitBeforeFirstStatusRequest!,
									waitingSecondsBetweenStatusRequests: method.decoupledWaitBetweenStatusRequests!,
									manualConfirmationAllowed: method.decoupledManualConfirmationAllowed ?? false,
									autoConfirmationAllowed: method.decoupledAutoConfirmationAllowed ?? false,
							  }
							: undefined,
					})) ?? [])
				);
			});

			let bankingUrl = this.config.bankingUrl;
			const hikom = response.findSegment<HIKOMSegment>(HIKOM.Id);
			if (hikom) {
				bankingUrl = hikom?.comParams.address;
				if (!bankingUrl.toLowerCase().startsWith('https://')) {
					bankingUrl = 'https://' + bankingUrl;
				}
			}

			const hipins = response.findSegment<HIPINSSegment>(HIPINS.Id);

			if (!hipins) {
				throw new Error('Bank does not support PIN/TAN transactions (HIPINS segment not found in BPA)');
			}

			const bankTransactions: BankTransaction[] = hipins.params.transactions.map((t) => {
				return { transId: t.transId, tanRequired: t.tanRequired, versions: [] };
			});

			bankTransactions.forEach((transaction) => {
				if (transaction.transId.startsWith('HK') || transaction.transId.startsWith('DK')) {
					const paramSegId = 'HI' + transaction.transId.slice(2) + 'S';
					const paramSegments = [
						...response.findAllSegments(paramSegId),
						...response.findAllUnknownSegments(paramSegId),
					];

					paramSegments.forEach((paramSegment) => {
						if (paramSegment) {
							transaction.versions.push(paramSegment.header.version);
						}
					});
				}
			});

			const bpd = {
				version: hibpa?.bpdVersion,
				countryCode: hibpa?.bank.country,
				bankId: hibpa?.bank.bankId,
				bankName: hibpa?.bankName,
				maxTransactionsPerMessage: hibpa?.maxNumTransactions,
				supportedLanguages: hibpa?.supportedLanguages,
				supportedHbciVersions: hibpa?.supportedHbciVersions,
				url: bankingUrl,
				supportedTanMethods: supportedTanMethods,
				availableTanMethodIds: [],
				allowedTransactions: bankTransactions,
			};

			this.config.bankingInformation.bpd = bpd;
		}

		const tanMethodMessaqe = bankAnswers.find((answer) => answer.code === 3920);
		let availableTanMethodIds: number[] = [];

		if (tanMethodMessaqe && this.config.bankingInformation.bpd) {
			this.config.bankingInformation.bpd.availableTanMethodIds =
				tanMethodMessaqe.params?.map((p) => Number.parseInt(p)) ?? [];
		}

		const hiupa = response.findSegment<HIUPASegment>(HIUPA.Id);

		if (hiupa) {
			const hiupds = response.findAllSegments<HIUPDSegment>(HIUPD.Id);
			const accounts: BankAccount[] = hiupds.map((upd) => {
				return {
					accountNumber: upd.account.accountNumber,
					subAccountId: upd.account.subAccountId,
					bank: upd.account.bank,
					iban: upd.iban,
					customerId: upd.customerId,
					accountType: finTsAccountTypeToEnum(upd.accountType),
					currency: upd.currency,
					holder1: upd.accountHolder1,
					holder2: upd.accountHolder2,
					product: upd.accountProduct,
					limit: upd.accountLimit,
					allowedTransactions: upd.allowedTransactions?.filter((t) => !!t),
				};
			});

			const upd = {
				version: hiupa.updVersion,
				usage: hiupa.updUsage,
				bankAccounts: accounts,
			};

			this.config.bankingInformation.upd = upd;
		}

		const hikimSegments = response.findAllSegments<HIKIMSegment>(HIKIM.Id);
		const bankMessages: BankMessage[] = hikimSegments.map((s) => ({ subject: s.subject, text: s.text }));
		this.config.bankingInformation.bankMessages = bankMessages;

		clientResponse.bankingInformation = this.config.bankingInformation;
		clientResponse.bankingInformationUpdated =
			currentBankingInformationSnapshot !== JSON.stringify(this.config.bankingInformation);
	}
}

function isDecoupledTanMethod(tanMethod: HitansTanMethod): boolean {
	if (tanMethod.zkaMethod === 'Decoupled' || tanMethod.zkaMethod === 'DecoupledPush') {
		return true;
	}

	if (
		tanMethod.decoupledMaxStatusRequests !== undefined ||
		tanMethod.decoupledWaitBeforeFirstStatusRequest !== undefined ||
		tanMethod.decoupledWaitBetweenStatusRequests !== undefined ||
		tanMethod.decoupledManualConfirmationAllowed !== undefined ||
		tanMethod.decoupledAutoConfirmationAllowed !== undefined
	) {
		return true;
	}

	return false;
}
