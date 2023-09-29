import { Wallet, retrieveGckmsKeys, getGckmsConfig, isDefined } from "./";

/**
 * Signer options for the getSigner function.
 */
export type SignerOptions = {
  /*
   * The type of wallet to use.
   * @note If using a GCKMS wallet, the gckmsKeys parameter must be set.
   */
  keyType: string;
  /**
   * Whether or not to clear the mnemonic/private key from the env after retrieving the signer.
   * @note Not including this parameter or setting it to false will not clear the mnemonic/private key from the env.
   */
  cleanEnv?: boolean;
  /**
   * The GCKMS keys to use.
   * @note This parameter is only required if the keyType is set to gckms.
   */
  gckmsKeys?: string[];
};

/**
 * Retrieves a signer based on the wallet type defined in the args.
 * @param cleanEnv If true, clears the mnemonic and private key from the env after retrieving the signer.
 * @returns A signer.
 * @throws If the wallet type is not defined or the mnemonic/private key is not set.
 * @note If cleanEnv is true, the mnemonic and private key will be cleared from the env after retrieving the signer.
 * @note This function will throw if called a second time after the first call with cleanEnv = true.
 */
export async function getSigner({ keyType, gckmsKeys, cleanEnv }: SignerOptions): Promise<Wallet> {
  let wallet: Wallet | undefined = undefined;
  switch (keyType) {
    case "mnemonic":
      wallet = getMnemonicSigner();
      break;
    case "privateKey":
      wallet = getPrivateKeySigner();
      break;
    case "gckms":
      wallet = await getGckmsSigner(gckmsKeys);
      break;
    default:
      throw new Error(`getSigner: Unsupported key type (${keyType})`);
  }
  if (!wallet) {
    throw new Error("Must define mnemonic, privatekey or gckms for wallet");
  }
  if (cleanEnv) {
    cleanKeysFromEnvironment();
  }
  return wallet;
}

/**
 * Retrieves a signer based on the mnemonic set in the env.
 * @returns A signer based on the mnemonic set in the env.
 * @throws If a valid private key is not defined in the environment.
 */
function getPrivateKeySigner(): Wallet {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Wallet private key selected but no PRIVATE_KEY env set!");
  }
  return new Wallet(process.env.PRIVATE_KEY);
}

/**
 * Retrieves a signer based on the GCKMS key set in the args.
 * @returns A signer based on the GCKMS key set in the args.
 * @throws If the GCKMS key is not set.
 */
async function getGckmsSigner(keys?: string[]): Promise<Wallet> {
  if (!isDefined(keys) || keys.length === 0) {
    throw new Error("Wallet GCKSM selected but no keys parameter set! Set GCKMS key to use");
  }
  const privateKeys = await retrieveGckmsKeys(getGckmsConfig(keys));
  return new Wallet(privateKeys[0]); // GCKMS retrieveGckmsKeys returns multiple keys. For now we only support 1.
}

/**
 * Retrieves a signer based on the mnemonic set in the env.
 * @returns A signer based on the mnemonic set in the env.
 * @throws If a valid mnemonic is not defined in the environment.
 */
function getMnemonicSigner(): Wallet {
  if (!process.env.MNEMONIC) {
    throw new Error("Wallet mnemonic selected but no MNEMONIC env set!");
  }
  return Wallet.fromMnemonic(process.env.MNEMONIC);
}

/**
 * Clears the mnemonic and private key from the env.
 */
function cleanKeysFromEnvironment(): void {
  if (process.env.MNEMONIC) {
    delete process.env.MNEMONIC;
  }
  if (process.env.PRIVATE_KEY) {
    delete process.env.PRIVATE_KEY;
  }
}
