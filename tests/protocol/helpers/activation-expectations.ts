import { jsonArray, jsonNumber, jsonObject, jsonString, jsonValue } from "./contract-helpers.ts";

export interface ExpectedActivationResource {
  media_type: string;
  path: string;
  size: number;
}

export interface ExpectedActivation {
  digest: string;
  files: ExpectedActivationResource[];
  frontmatter: object;
  instructions: string;
  name: string;
  origin_alias: string;
  outcome: string;
  requests: number;
}

export function decodeActivationResources(
  value: unknown,
  label: string,
): ExpectedActivationResource[] {
  return jsonArray(value, label).map((item, index) => {
    const resourceLabel = `${label}[${index}]`;
    const resource = jsonObject(item, resourceLabel);
    const size = jsonNumber(jsonValue(resource, "size", resourceLabel), `${resourceLabel}.size`);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`${resourceLabel}.size must be a non-negative safe integer`);
    }
    return {
      path: jsonString(jsonValue(resource, "path", resourceLabel), `${resourceLabel}.path`),
      size,
      media_type: jsonString(
        jsonValue(resource, "media_type", resourceLabel),
        `${resourceLabel}.media_type`,
      ),
    };
  });
}

export function decodeActivationExpectations(value: unknown) {
  const document = jsonObject(value, "activation expectations");
  return {
    cases: jsonArray(
      jsonValue(document, "cases", "activation expectations"),
      "activation expectations.cases",
    ).map((item, index) => {
      const label = `activation expectations.cases[${index}]`;
      const entry = jsonObject(item, label);
      const result = jsonObject(jsonValue(entry, "result", label), `${label}.result`);
      return {
        id: jsonString(jsonValue(entry, "id", label), `${label}.id`),
        result: {
          digest: jsonString(
            jsonValue(result, "digest", `${label}.result`),
            `${label}.result.digest`,
          ),
          files: decodeActivationResources(
            jsonValue(result, "files", `${label}.result`),
            `${label}.result.files`,
          ),
          frontmatter: jsonObject(
            jsonValue(result, "frontmatter", `${label}.result`),
            `${label}.result.frontmatter`,
          ),
          instructions: jsonString(
            jsonValue(result, "instructions", `${label}.result`),
            `${label}.result.instructions`,
          ),
          name: jsonString(jsonValue(result, "name", `${label}.result`), `${label}.result.name`),
          origin_alias: jsonString(
            jsonValue(result, "origin_alias", `${label}.result`),
            `${label}.result.origin_alias`,
          ),
          outcome: jsonString(
            jsonValue(result, "outcome", `${label}.result`),
            `${label}.result.outcome`,
          ),
          requests: jsonNumber(
            jsonValue(result, "requests", `${label}.result`),
            `${label}.result.requests`,
          ),
        },
      };
    }),
  };
}
