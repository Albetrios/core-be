/**
 * Converts OpenAPI spec (docs/openapi/openapi.json) to a Postman Collection v2.1.
 *
 * Prerequisite: Run `pnpm docs:generate` first to produce docs/openapi/openapi.json.
 * Run:          pnpm docs:postman
 * Output:       docs/postman-collection.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Faker } from '@faker-js/faker';
import { join } from 'node:path';

// openapi-to-postmanv2 ships CJS — use createRequire for ESM compat
import { Module, createRequire } from 'node:module';
import {
  POSTMAN_COLLECTION_PREFIX,
  PROJECT_DISPLAY_NAME,
  SCALAR_SLUG_DEFAULT,
} from '@/shared/constants/project-identity.constants.js';

const require = createRequire(import.meta.url);

type LegacyNumberOptions = {
  max?: number;
  min?: number;
};

function createPostmanCollectionFakerCompat(faker: Faker): Record<string, unknown> {
  const imageByCategory = (category: string): (() => string) => {
    return () => faker.image.urlLoremFlickr({ category });
  };

  return {
    ...faker,
    address: {
      city: () => faker.location.city(),
      country: () => faker.location.country(),
      countryCode: () => faker.location.countryCode(),
      latitude: () => faker.location.latitude(),
      longitude: () => faker.location.longitude(),
      streetAddress: () => faker.location.streetAddress(),
      streetName: () => faker.location.street(),
    },
    commerce: {
      ...faker.commerce,
      color: () => faker.color.human(),
    },
    company: {
      ...faker.company,
      bs: () => faker.company.buzzPhrase(),
      bsAdjective: () => faker.company.buzzAdjective(),
      bsBuzz: () => faker.company.buzzVerb(),
      bsNoun: () => faker.company.buzzNoun(),
      companyName: () => faker.company.name(),
      companySuffix: () => faker.helpers.arrayElement(['Inc', 'LLC', 'Group']),
    },
    datatype: {
      ...faker.datatype,
      number: (options?: LegacyNumberOptions | number) => faker.number.int(options),
      uuid: () => faker.string.uuid(),
    },
    finance: {
      ...faker.finance,
      account: () => faker.finance.accountNumber(),
      mask: () => faker.finance.creditCardNumber(),
    },
    image: {
      ...faker.image,
      abstract: imageByCategory('abstract'),
      animals: imageByCategory('animals'),
      business: imageByCategory('business'),
      cats: imageByCategory('cats'),
      city: imageByCategory('city'),
      fashion: imageByCategory('fashion'),
      food: imageByCategory('food'),
      imageUrl: () => faker.image.url(),
      nature: imageByCategory('nature'),
      nightlife: imageByCategory('nightlife'),
      people: imageByCategory('people'),
      sports: imageByCategory('sports'),
      transport: imageByCategory('transport'),
    },
    internet: {
      ...faker.internet,
      color: () => faker.color.rgb({ prefix: '#' }),
      userName: () => faker.internet.username(),
    },
    name: {
      findName: () => faker.person.fullName(),
      firstName: () => faker.person.firstName(),
      jobArea: () => faker.person.jobArea(),
      jobDescriptor: () => faker.person.jobDescriptor(),
      jobTitle: () => faker.person.jobTitle(),
      jobType: () => faker.person.jobType(),
      lastName: () => faker.person.lastName(),
      prefix: () => faker.person.prefix(),
      suffix: () => faker.person.suffix(),
    },
    phone: {
      ...faker.phone,
      phoneNumber: () => faker.phone.number(),
      phoneNumberFormat: () => faker.phone.number(),
    },
    random: {
      alphaNumeric: (count = 1) => faker.string.alphanumeric(count),
      arrayElement: <T>(items: readonly T[]) => faker.helpers.arrayElement(items),
      word: () => faker.lorem.word(),
    },
  };
}

function installPostmanCollectionFakerCompat(): void {
  const fakerLocalePath = require.resolve('@faker-js/faker/locale/en');
  const fakerLocaleModule = require('@faker-js/faker/locale/en') as { faker: Faker };
  const fakerShimModule = new Module(fakerLocalePath);
  fakerShimModule.filename = fakerLocalePath;
  fakerShimModule.loaded = true;
  fakerShimModule.exports = createPostmanCollectionFakerCompat(fakerLocaleModule.faker);
  require.cache[fakerLocalePath] = fakerShimModule;
}

installPostmanCollectionFakerCompat();
const Converter = require('openapi-to-postmanv2');

const OPENAPI_PATH = join(process.cwd(), 'docs', 'openapi', 'openapi.json');
const OUTPUT_PATH = join(process.cwd(), 'docs', 'postman-collection.json');
const PACKAGE_JSON_PATH = join(process.cwd(), 'package.json');
const SCALAR_REGISTRY_BASE_URL = 'https://registry.scalar.com';

interface CollectionInfo {
  name: string;
  description: string;
  schema: string;
  [key: string]: unknown;
}

interface PostmanCollection {
  info: CollectionInfo;
  [key: string]: unknown;
}

function getPackageVersion(): string {
  const packageData = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  return packageData.version ?? '0.0.0';
}

function buildScalarRegistryUrl(): string | undefined {
  const namespace = process.env.SCALAR_NAMESPACE;
  const slug = process.env.SCALAR_SLUG ?? SCALAR_SLUG_DEFAULT;
  if (!namespace) {
    return undefined;
  }
  return `${SCALAR_REGISTRY_BASE_URL}/@${namespace}/apis/${slug}/latest`;
}

function main(): void {
  const openapiData = readFileSync(OPENAPI_PATH, 'utf-8');
  const version = getPackageVersion();

  // Validate the OpenAPI spec before converting
  const validationResult = Converter.validate({ type: 'string', data: openapiData });
  if (!validationResult.result) {
    console.error(`OpenAPI validation failed: ${validationResult.reason}`);
    process.exit(1);
  }

  const conversionOptions = {
    schemaFaker: false,
    folderStrategy: 'Paths',
    requestNameSource: 'Fallback',
    indentCharacter: '  ',
    parametersResolution: 'Example',
    exampleParametersResolution: 'Example',
    optimizeConversion: true,
    includeAuthInfoInExample: true,
  };

  Converter.convert(
    { type: 'string', data: openapiData },
    conversionOptions,
    (
      error: Error | null,
      conversionResult: {
        result: boolean;
        reason?: string;
        output: Array<{ type: string; data: PostmanCollection }>;
      },
    ) => {
      if (error) {
        console.error('Conversion error:', error.message);
        process.exit(1);
      }

      if (!conversionResult.result) {
        console.error('Could not convert:', conversionResult.reason);
        process.exit(1);
      }

      const collectionData = conversionResult.output[0]?.data;
      if (!collectionData) {
        console.error('No collection data in conversion output');
        process.exit(1);
      }

      // Collection-level bearer auth: every authed request inherits
      // `Authorization: Bearer {{ACCESS_TOKEN}}` — set the variable once.
      collectionData.auth = {
        type: 'bearer',
        bearer: [{ key: 'token', value: '{{ACCESS_TOKEN}}', type: 'string' }],
      };
      collectionData.variable = [
        ...((collectionData.variable as unknown[] | undefined) ?? []),
        { key: 'ACCESS_TOKEN', value: '', type: 'string' },
      ];

      // Stamp version into collection info for traceability
      collectionData.info.name = `${POSTMAN_COLLECTION_PREFIX} v${version}`;
      const scalarRegistryUrl = buildScalarRegistryUrl();
      const scalarRegistryLine = scalarRegistryUrl ? `\nScalar Registry: ${scalarRegistryUrl}` : '';
      collectionData.info.description = `Auto-generated Postman Collection for ${PROJECT_DISPLAY_NAME} v${version}.\nSource: docs/openapi/openapi.json (regenerate with pnpm docs:postman)${scalarRegistryLine}`;

      writeFileSync(OUTPUT_PATH, JSON.stringify(collectionData, null, 2), 'utf-8');

      const openapiSpec = JSON.parse(openapiData);
      const routeCount = Object.keys(openapiSpec.paths ?? {}).length;
      console.log(
        `Generated ${OUTPUT_PATH} (v${version}, ${routeCount} paths → Postman Collection v2.1)`,
      );
    },
  );
}

main();
