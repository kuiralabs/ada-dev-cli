// CIP-57 blueprint handling.
//
// The first suite is a regression test in the strict sense: it fails against the
// version that hashed `compiledCode` directly, which is what this code did until
// 5 ADA was locked at an address the tool reported and the chain did not agree
// with. The fixture is the real hello-world blueprint, and the expected address
// is what `aiken blueprint address` prints for it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBlueprint, selectValidator, scriptBytes, scriptIdentity, assertParametersApplied,
  splitTitle, listNames, handlersOf, parseParams, describeExpected, type Blueprint,
} from '../lib/blueprint.ts';
import { AdaError } from '../lib/errors.ts';

// The real aiken-lang/hello_world validator, compiled by Aiken v1.1.23.
const HELLO_COMPILED =
  '59010601010029800aba2aba1aab9faab9eaab9dab9a48888896600264646644b30013370e900118031baa0018991991' +
  '2cc004cdc3a400060126ea801626464b3001300f0028acc004cdc3a400060166ea800e2b30013371e9110d48656c6c6f' +
  '2c20576f726c642100375c601c60186ea801e26466446600400400244b30010018a508acc004cdc79bae30110010038a' +
  '518998010011809000a01a40406eb0c03cc040c040c040c040c040c040c040c040c034dd518078051bae300e300c3754' +
  '601c60186ea800e294100a45900a45900d1bae300d001300a375400b164020601400260146016002600e6ea80062c802' +
  '8c01c004c01cc020004c01c004c00cdd5003c52689b2b20021';

const HELLO_HASH = '61862d972a99950111010c9ce8c16765d62855cb6e1cc1b8bc6d4505';
// What `aiken blueprint address` prints for that blueprint.
const HELLO_ADDR = 'addr_test1wpscvtvh92ve2qg3qyxfe6xpvajav2z4edhpesdch3k52pgwflxk8';

const helloDoc: Blueprint = {
  preamble: { title: 'aiken-lang/hello_world', plutusVersion: 'v3',
              compiler: { name: 'Aiken', version: 'v1.1.23' } },
  validators: [
    { title: 'hello_world.hello_world.spend', compiledCode: HELLO_COMPILED, hash: HELLO_HASH,
      datum: { title: 'Datum' }, redeemer: { title: 'Redeemer' } },
    { title: 'hello_world.hello_world.else', compiledCode: HELLO_COMPILED, hash: HELLO_HASH },
  ],
};

/** Write a blueprint into a throwaway directory and load it. */
function loadDoc(doc: unknown, subdir = ''): ReturnType<typeof loadBlueprint> {
  const root = mkdtempSync(join(tmpdir(), 'ada-bp-'));
  const dir = subdir ? join(root, subdir) : root;
  if (subdir) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plutus.json'), JSON.stringify(doc));
  return loadBlueprint(undefined, root);
}

describe('the script that gets hashed is not compiledCode', () => {
  const loaded = loadDoc(helloDoc);
  const validator = selectValidator(loaded);

  it('double-wraps the compiled code', () => {
    // compiledCode is single-CBOR-encoded; the hash covers the wrapped form.
    const bytes = scriptBytes(validator);
    expect(bytes).not.toBe(HELLO_COMPILED);
    expect(bytes.length).toBeGreaterThan(HELLO_COMPILED.length);
    // The wrapper prefixes a new CBOR byte-string header around the original.
    expect(bytes.endsWith(HELLO_COMPILED)).toBe(true);
  });

  it('produces the hash the blueprint itself declares', () => {
    // The blueprint's own `hash` field is the ground truth here — if our
    // derivation disagrees with it, one of the two is wrong and it is not Aiken.
    expect(scriptIdentity(loaded, validator, 'devnet').hash).toBe(HELLO_HASH);
  });

  it('produces the address `aiken blueprint address` prints', () => {
    // Hashing compiledCode directly yields addr_test1wrajwv4l3… instead, which is
    // where 5 ADA went while this was being written.
    expect(scriptIdentity(loaded, validator, 'devnet').address).toBe(HELLO_ADDR);
  });

  it('discriminates the network, so one address cannot be used on another', () => {
    const testnet = scriptIdentity(loaded, validator, 'devnet').address;
    const mainnet = scriptIdentity(loaded, validator, 'mainnet').address;
    expect(testnet.startsWith('addr_test1')).toBe(true);
    expect(mainnet.startsWith('addr1')).toBe(true);
    expect(testnet).not.toBe(mainnet);
  });

  it('gives preview and preprod the same address as devnet — all are testnets', () => {
    const at = (n: 'devnet' | 'preprod' | 'preview') => scriptIdentity(loaded, validator, n).address;
    expect(at('preprod')).toBe(at('devnet'));
    expect(at('preview')).toBe(at('devnet'));
  });
});

describe('a parameterised validator has no single address', () => {
  const doc: Blueprint = {
    preamble: { plutusVersion: 'v3' },
    validators: [{
      title: 'oneshot.gift_card.mint', compiledCode: HELLO_COMPILED,
      parameters: [{ title: 'token_name' }, { title: 'utxo_ref' }],
    }],
  };
  const loaded = loadDoc(doc);
  const validator = selectValidator(loaded);

  it('refuses to answer when parameters are unapplied', () => {
    // Answering anyway would report an address that changes the moment the
    // parameters are supplied — confidently wrong is worse than refusing.
    expect(() => scriptIdentity(loaded, validator, 'devnet')).toThrow(AdaError);
    try { scriptIdentity(loaded, validator, 'devnet'); } catch (e) {
      expect((e as AdaError).code).toBe('parameters_required');
    }
  });

  it('names the parameters that are missing', () => {
    try { assertParametersApplied(validator, 0); } catch (e) {
      expect((e as AdaError).hint).toContain('token_name');
      expect((e as AdaError).hint).toContain('utxo_ref');
    }
  });

  it('names only the ones still outstanding when some were supplied', () => {
    try { assertParametersApplied(validator, 1); } catch (e) {
      expect((e as AdaError).hint).toContain('utxo_ref');
      expect((e as AdaError).hint).not.toContain('token_name');
    }
  });

  it('accepts once every parameter is supplied', () => {
    expect(() => assertParametersApplied(validator, 2)).not.toThrow();
  });

  it('changes the hash when a parameter is applied', () => {
    const bare = scriptBytes(validator, []);
    const applied = scriptBytes(validator, ['deadbeef']);
    expect(applied).not.toBe(bare);
  });
});

describe('selecting a validator from handler-per-entry blueprints', () => {
  it('treats several handlers of one validator as one program, not ambiguity', () => {
    // .spend and .else share a hash and a compiled program.
    const loaded = loadDoc(helloDoc);
    expect(() => selectValidator(loaded)).not.toThrow();
  });

  it('prefers a real handler over the else fallback', () => {
    const loaded = loadDoc(helloDoc);
    expect(splitTitle(selectValidator(loaded).title).handler).toBe('spend');
  });

  it('refuses when two distinct validators match', () => {
    const loaded = loadDoc({ preamble: { plutusVersion: 'v3' }, validators: [
      { title: 'a.one.spend', compiledCode: HELLO_COMPILED },
      { title: 'b.two.spend', compiledCode: HELLO_COMPILED },
    ] });
    try { selectValidator(loaded); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('validator_ambiguous');
      expect((e as AdaError).hint).toContain('a.one');
      expect((e as AdaError).hint).toContain('b.two');
    }
  });

  it('narrows by module and validator', () => {
    const loaded = loadDoc({ preamble: { plutusVersion: 'v3' }, validators: [
      { title: 'a.one.spend', compiledCode: HELLO_COMPILED },
      { title: 'b.two.spend', compiledCode: HELLO_COMPILED },
    ] });
    expect(selectValidator(loaded, { module: 'b' }).title).toBe('b.two.spend');
  });

  it('selects a specific handler when asked', () => {
    const loaded = loadDoc({ preamble: { plutusVersion: 'v3' }, validators: [
      { title: 'g.card.spend', compiledCode: HELLO_COMPILED },
      { title: 'g.card.mint', compiledCode: HELLO_COMPILED },
    ] });
    expect(selectValidator(loaded, { handler: 'mint' }).title).toBe('g.card.mint');
  });

  it('lists available names when nothing matches', () => {
    const loaded = loadDoc(helloDoc);
    try { selectValidator(loaded, { module: 'nope' }); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('validator_not_found');
      expect((e as AdaError).hint).toContain('hello_world.hello_world');
    }
  });

  it('reports distinct validators and their handlers', () => {
    expect(listNames(helloDoc.validators)).toEqual(['hello_world.hello_world']);
    expect(handlersOf(helloDoc.validators, 'hello_world.hello_world')).toEqual(['else', 'spend']);
  });
});

describe('the Plutus version is read, never assumed', () => {
  it('reads v3 from the preamble', () => {
    expect(loadDoc(helloDoc).version).toBe('V3');
  });

  it('reads v2 rather than defaulting to the newest', () => {
    // Assuming V3 would price a V2 script against the wrong cost model.
    expect(loadDoc({ ...helloDoc, preamble: { plutusVersion: 'v2' } }).version).toBe('V2');
  });

  it('rejects a blueprint with no version rather than guessing', () => {
    try { loadDoc({ preamble: {}, validators: [] }); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('blueprint_invalid');
    }
  });
});

describe('finding the blueprint', () => {
  it('finds one at the project root', () => {
    expect(loadDoc(helloDoc).path.endsWith('plutus.json')).toBe(true);
  });

  it('finds one in a subdirectory a real project might use', () => {
    // Upstream tooling assumes the root; monorepos routinely do not. The Midnight
    // CLI carries the same candidate list for the same reason.
    for (const dir of ['onchain', 'contract', 'contracts', 'aiken']) {
      expect(loadDoc(helloDoc, dir).path).toContain(dir);
    }
  });

  it('says what to do when there is no blueprint', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ada-bp-'));
    try { loadBlueprint(undefined, empty); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('blueprint_not_found');
      expect((e as AdaError).hint).toContain('aiken build');
    }
  });

  it('rejects malformed JSON with the file named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ada-bp-'));
    writeFileSync(join(dir, 'plutus.json'), '{ not json');
    try { loadBlueprint(undefined, dir); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('blueprint_invalid');
    }
  });

  it('rejects a JSON file that is not a blueprint', () => {
    try { loadDoc({ preamble: { plutusVersion: 'v3' }, hello: 'world' }); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('blueprint_invalid');
    }
  });
});

describe('parsing --params', () => {
  it('treats an absent flag as no parameters', () => {
    expect(parseParams(undefined)).toEqual([]);
  });

  it('accepts a JSON array', () => {
    expect(parseParams('["deadbeef", 42]')).toEqual(['deadbeef', 42]);
  });

  it('rejects a bare value, since parameters are positional', () => {
    expect(() => parseParams('42')).toThrow(/JSON array/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseParams('[1,')).toThrow(/not valid JSON/);
  });
});

describe('a parameter with a shape', () => {
  it('describes what it expects, not only its name', () => {
    // `inspect` reported a bare `oracle` for a parameter wanting a structured
    // Address, and working out that it needed nested constructors was
    // hand-derivation from the CIP. The blueprint carried the schema all along;
    // nothing ever asked it for one.
    const doc: Blueprint = {
      preamble: { title: 'kuiralabs/price_gate', plutusVersion: 'v3' },
      definitions: {
        'cardano/address/Address': {
          title: 'Address',
          anyOf: [{ title: 'Address', dataType: 'constructor', index: 0, fields: [{}, {}] }],
        },
      },
      validators: [{
        title: 'gate.gate.spend',
        compiledCode: HELLO_COMPILED,
        hash: HELLO_HASH,
        parameters: [{ title: 'oracle', schema: { $ref: '#/definitions/cardano~1address~1Address' } }],
      }],
    };
    const loaded = { path: 'plutus.json', doc, version: 'V3' as const };
    const described = describeExpected(doc.validators[0].parameters?.[0].schema, loaded);
    expect(described).toContain('Address');
  });

  it('says nothing rather than guessing when no schema is declared', () => {
    const loaded = { path: 'plutus.json', doc: helloDoc, version: 'V3' as const };
    expect(describeExpected(undefined, loaded)).toBeUndefined();
  });
});
