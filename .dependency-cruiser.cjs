function forbid(name, fromPath, toPath, comment) {
  return {
    name,
    severity: "error",
    comment,
    from: {
      path: fromPath,
    },
    to: {
      path: toPath,
    },
  };
}

const clientsPath = "^(src/(cli|tui)/|apps/|ui/)";
const npmDependencyTypes = [
  "npm",
  "npm-dev",
  "npm-optional",
  "npm-peer",
  "npm-bundled",
  "npm-no-pkg",
];

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "This dependency is part of a circular relationship. Revise the dependency direction or extract a lower layer abstraction.",
      from: {},
      to: {
        circular: true,
      },
    },
    forbid(
      "protocol-no-upward-deps",
      "^packages/protocol/",
      "^(packages/(?!protocol/)|src/|apps/|extensions/|skills/|ui/)",
      "packages/protocol must remain the lowest workspace layer.",
    ),
    forbid(
      "utils-no-upward-deps",
      "^packages/utils/",
      "^(packages/(core|sdk)/|src/|apps/|extensions/|skills/|ui/)",
      "packages/utils is a base helper layer and must not depend on runtime or client layers.",
    ),
    forbid(
      "core-no-upward-deps",
      "^packages/core/",
      "^(packages/(sdk|agent-sdk)/|src/|apps/|extensions/|skills/|ui/)",
      "packages/core must not depend on gateway, client, skill, or extension implementation layers.",
    ),
    forbid(
      "bootstrap-no-runtime-deps",
      "^src/bootstrap/",
      "^(src/(?!bootstrap/)|apps/|extensions/|skills/|ui/)",
      "src/bootstrap is shared startup glue and must not depend on gateway, command, runtime, client, skill, or extension layers.",
    ),
    forbid(
      "sdk-no-implementation-deps",
      "^packages/sdk/",
      "^(packages/core/|src/|apps/|extensions/|skills/|ui/)",
      "packages/sdk must not depend on runtime implementation or client layers.",
    ),
    forbid(
      "agent-sdk-no-implementation-deps",
      "^packages/agent-sdk/",
      "^(packages/sdk/|src/|apps/|extensions/|skills/|ui/)",
      "packages/agent-sdk depends on core/protocol/utils only; must not reach into gateway, clients, extensions, or other apps.",
    ),
    forbid(
      "skills-no-host-deps",
      "^skills/",
      "^(packages/sdk/|src/|apps/|extensions/|ui/)",
      "skills/* may depend on core abstractions, but not on gateway, clients, or extensions.",
    ),
    forbid(
      "extensions-no-client-deps",
      "^extensions/",
      "^(packages/sdk/|src/(?!gateway/)|apps/|skills/|ui/)",
      "extensions/* may integrate external systems, but must not depend on clients or unrelated app assembly code.",
    ),
    forbid(
      "gateway-no-bootstrap-deps",
      "^src/gateway/",
      "^src/bootstrap/",
      "src/gateway should consume resolved runtime config and must not read bootstrap config files directly.",
    ),
    forbid(
      "gateway-no-client-deps",
      "^src/gateway/",
      clientsPath,
      "src/gateway is the host authority and must not import client implementations.",
    ),
    forbid(
      "clients-no-server-or-core-deps",
      clientsPath,
      "^(packages/core/|src/(bootstrap|gateway)/|extensions/|skills/)",
      "Clients must not bypass SDK/bootstrap boundaries and import bootstrap config loading, gateway, core implementation, skills, or extensions directly.",
    ),
  ],
  options: {
    tsConfig: {
      fileName: "tsconfig.json",
    },
    doNotFollow: {
      path: ["node_modules"],
      dependencyTypes: npmDependencyTypes,
    },
    exclude: {
      path: ["(^|/)(dist|node_modules|coverage|\\.turbo|\\.cache)(/|$)"],
    },
    includeOnly: ["^(src|packages|apps|extensions|skills|ui)(/|$)"],
    moduleSystems: ["es6", "cjs"],
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      mainFields: ["types", "module", "main"],
    },
    skipAnalysisNotInRules: true,
  },
};
