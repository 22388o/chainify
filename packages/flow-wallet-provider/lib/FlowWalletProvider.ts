import { WalletProvider } from '@liquality/wallet-provider'
import { Address, ChainProvider, Network, Transaction, SendOptions, flow, BigNumber } from '@liquality/types'
import { addressToString } from '@liquality/utils'
import { FlowNetwork } from '@liquality/flow-networks'
import { formatTokenUnits } from '@liquality/flow-utils'

import * as fcl from '@onflow/fcl'
import * as types from '@onflow/types'

import { ec as EC } from 'elliptic'
import { SHA3 } from 'sha3'
import hdkey from 'hdkey'
import { mnemonicToSeed } from 'bip39'

interface FlowJsWalletProviderOptions {
  network: FlowNetwork
  mnemonic: string
  derivationPath: string
}

interface FlowSendOptions extends SendOptions {
  args: any[]
  keyId?: string
}

export default class FlowWalletProvider extends WalletProvider implements Partial<ChainProvider> {
  _network: FlowNetwork
  private _mnemonic: string
  private _derivationPath: string
  private _addressCache: { [key: string]: Address }
  private _privateKey: string

  constructor(options: FlowJsWalletProviderOptions) {
    const { network, mnemonic, derivationPath } = options
    super({ network })
    this._network = network
    this._mnemonic = mnemonic
    this._derivationPath = derivationPath || `m/44'/${this._network.coinType}'/771'/0'/0`
    this._addressCache = {}
    this._privateKey = null

    fcl
      .config()
      .put('accessNode.api', this._network.rpcUrl)
      .put('env', this._network.isTestnet ? 'testnet' : 'mainnet')
    // .put('0xFUNGIBLETOKENADDRESS') // TODO:
  }

  async getAddresses(): Promise<Address[]> {
    if (this._addressCache[this._mnemonic]) {
      return [this._addressCache[this._mnemonic]]
    }

    const keys = await this._generateKeys()
    this._privateKey = keys.private

    const result = new Address({
      address: await this.getMethod('accountAddress')(keys.public),
      derivationPath: this._derivationPath,
      publicKey: keys.public
    })

    this._addressCache[this._mnemonic] = result
    return [result]
  }

  async isWalletAvailable(): Promise<boolean> {
    const addresses = await this.getAddresses()
    return addresses.length > 0
  }

  async getUsedAddresses(): Promise<Address[]> {
    return this.getAddresses()
  }

  async getUnusedAddress(): Promise<Address> {
    const addresses = await this.getAddresses()
    return addresses[0]
  }

  // message should be in hex format
  async signMessage(msgHex: string): Promise<string> {
    await this.getAddresses() // initialize wallet

    const ec = new EC('p256')
    const key = ec.keyFromPrivate(Buffer.from(this._privateKey, 'hex'))
    const sig = key.sign(this._hashMessage(msgHex))
    const n = 32
    const r = sig.r.toArrayLike(Buffer, 'be', n)
    const s = sig.s.toArrayLike(Buffer, 'be', n)
    return Buffer.concat([r, s]).toString('hex')
  }

  async getConnectedNetwork(): Promise<Network> {
    return this._network
  }

  async sendSweepTransaction(addressTo: Address | string): Promise<Transaction<flow.Tx>> {
    const [addressFrom] = await this.getAddresses()

    const balance = await this.getAccountBalance(addressToString(addressFrom))
    const balanceFormatted = formatTokenUnits(balance, 8)

    return this.sendTransaction({
      to: addressFrom,
      value: new BigNumber(0),
      data: `\
      import FungibleToken from 0xFUNGIBLETOKENADDRESS
      transaction(amount: UFix64, to: Address) {
      let vault: @FungibleToken.Vault
      prepare(signer: AuthAccount) {
      self.vault <- signer
      .borrow<&{FungibleToken.Provider}>(from: /storage/flowTokenVault)!
      .withdraw(amount: amount)
      }
      execute {
      getAccount(to)
      .getCapability(/public/flowTokenReceiver)!
      .borrow<&{FungibleToken.Receiver}>()!
      .deposit(from: <-self.vault)
      }
      }`,
      args: [fcl.arg(balanceFormatted, types.UFix64), fcl.arg(addressToString(addressTo), types.String)]
    })
  }

  async sendTransaction(options: FlowSendOptions): Promise<Transaction<flow.Tx>> {
    const [address] = await this.getAddresses()

    const authz = this.authz(addressToString(address), options.keyId || '0')

    const response = await fcl
      .send([
        fcl.transaction`
        ${options.data}
        `,
        fcl.args(options.args),
        fcl.proposer(authz),
        fcl.authorizations(authz),
        fcl.payer(authz),
        fcl.limit(9999)
      ])
      .then(fcl.decode)

    return this.getMethod('getTransactionByHash')(response)
  }

  // ===== FLOW SPECIFIC FEATURES =====
  // use 0 key id as default
  authz(flowAccountAddress: string, flowAccountKeyId: string) {
    return (account: any) => {
      return {
        ...account,
        tempId: [flowAccountAddress, flowAccountKeyId].join('-'),
        addr: fcl.sansPrefix(flowAccountAddress),
        keyId: Number(flowAccountKeyId),
        signingFunction: (signable: { message: string }) => ({
          addr: fcl.withPrefix(flowAccountAddress),
          keyId: Number(flowAccountKeyId),
          signature: this.signMessage(signable.message)
        })
      }
    }
  }

  async getAccountBalance(address: string) {
    const account = await fcl.send([fcl.getAccount(address)]).then(fcl.decode)
    return account.balance
  }

  // ===== HELPER METHODS =====
  private _hashMessage(message: string) {
    const sha = new SHA3(256)
    sha.update(Buffer.from(message, 'hex'))
    return sha.digest()
  }

  private async _generateKeys() {
    const seed = await mnemonicToSeed(this._mnemonic)
    const node = await hdkey.fromMasterSeed(seed)
    // public key is compressed
    const hdKey = node.derive(this._derivationPath)

    // generating a non compressed public key
    const ec = new EC('secp256k1')
    const keyPair = ec.keyFromPrivate(hdKey._privateKey.toString('hex'))
    const privKey = keyPair.getPrivate('hex')
    const pubKey = keyPair.getPublic('hex').replace(/^04/, '')

    return { private: privKey, public: pubKey }
  }
}
