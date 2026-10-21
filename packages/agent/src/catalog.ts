// Model catalog from T3 Code (Nightly) bundled model manifest, version 1, updated 2026-10-19T07:21:38Z.
// Copyright (c) 2026 T3 Tools Inc. MIT License, see LICENSE-t3code. Regenerate from the
// manifest when models change; do not edit entries by hand.

export type CatalogOption = { id: string; label: string; isDefault?: boolean; description?: string };
export type CatalogOptionDescriptor =
  | { id: string; label: string; type: "select"; options: CatalogOption[]; promptInjectedValues?: string[] }
  | { id: string; label: string; type: "boolean"; currentValue?: boolean };
export type ClaudeCatalogModel = {
  slug: string;
  name: string;
  status: "current" | "legacy";
  minVersion: string | null;
  options: CatalogOptionDescriptor[];
  /** Picker effort values that Claude Code receives differently. null means prompt-only. */
  effortMap: Record<string, string | null>;
};

export const claudeCatalog: ClaudeCatalogModel[] = [
  {
    "slug": "claude-opus-5-5",
    "name": "Opus 5.5",
    "status": "current",
    "minVersion": "2.1.280",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium",
            "isDefault": true
          },
          {
            "id": "high",
            "label": "High"
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultracode",
            "label": "Ultracode",
            "description": "xhigh effort plus multi-agent workflow orchestration"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      },
      {
        "id": "fastMode",
        "label": "Fast Mode",
        "type": "boolean"
      }
    ],
    "effortMap": {
      "ultracode": "xhigh",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-sonnet-5-5",
    "name": "Sonnet 5.5",
    "status": "current",
    "minVersion": "2.1.284",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      }
    ],
    "effortMap": {
      "ultrathink": null
    }
  },
  {
    "slug": "claude-fable-5-1",
    "name": "Fable 5.1",
    "status": "current",
    "minVersion": "2.1.257",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium",
            "isDefault": true
          },
          {
            "id": "high",
            "label": "High"
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultracode",
            "label": "Ultracode",
            "description": "xhigh effort plus multi-agent workflow orchestration"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      }
    ],
    "effortMap": {
      "ultracode": "xhigh",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-fable-5",
    "name": "Fable 5",
    "status": "legacy",
    "minVersion": "2.1.169",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium",
            "isDefault": true
          },
          {
            "id": "high",
            "label": "High"
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultracode",
            "label": "Ultracode",
            "description": "xhigh effort plus multi-agent workflow orchestration"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      }
    ],
    "effortMap": {
      "ultracode": "xhigh",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-opus-5",
    "name": "Opus 5",
    "status": "legacy",
    "minVersion": "2.1.219",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultracode",
            "label": "Ultracode",
            "description": "xhigh effort plus multi-agent workflow orchestration"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      },
      {
        "id": "fastMode",
        "label": "Fast Mode",
        "type": "boolean"
      }
    ],
    "effortMap": {
      "ultracode": "xhigh",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-opus-4-8",
    "name": "Opus 4.8",
    "status": "legacy",
    "minVersion": "2.1.154",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultracode",
            "label": "Ultracode",
            "description": "xhigh effort plus multi-agent workflow orchestration"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      },
      {
        "id": "fastMode",
        "label": "Fast Mode",
        "type": "boolean"
      }
    ],
    "effortMap": {
      "ultracode": "xhigh",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-opus-4-7",
    "name": "Opus 4.7",
    "status": "legacy",
    "minVersion": "2.1.111",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High"
          },
          {
            "id": "xhigh",
            "label": "Extra High",
            "isDefault": true
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      },
      {
        "id": "fastMode",
        "label": "Fast Mode",
        "type": "boolean"
      }
    ],
    "effortMap": {
      "xhigh": "max",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-opus-4-6",
    "name": "Opus 4.6",
    "status": "legacy",
    "minVersion": null,
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      },
      {
        "id": "fastMode",
        "label": "Fast Mode",
        "type": "boolean"
      },
      {
        "id": "contextWindow",
        "label": "Context Window",
        "type": "select",
        "options": [
          {
            "id": "200k",
            "label": "200k"
          },
          {
            "id": "1m",
            "label": "1M",
            "isDefault": true
          }
        ]
      }
    ],
    "effortMap": {
      "ultrathink": null
    }
  },
  {
    "slug": "claude-opus-4-5",
    "name": "Opus 4.5",
    "status": "legacy",
    "minVersion": null,
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "max",
            "label": "Max"
          }
        ]
      },
      {
        "id": "fastMode",
        "label": "Fast Mode",
        "type": "boolean"
      }
    ],
    "effortMap": {}
  },
  {
    "slug": "claude-sonnet-5",
    "name": "Sonnet 5",
    "status": "legacy",
    "minVersion": null,
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      }
    ],
    "effortMap": {
      "ultrathink": null
    }
  },
  {
    "slug": "claude-sonnet-4-6",
    "name": "Sonnet 4.6",
    "status": "legacy",
    "minVersion": null,
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium"
          },
          {
            "id": "high",
            "label": "High",
            "isDefault": true
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      },
      {
        "id": "contextWindow",
        "label": "Context Window",
        "type": "select",
        "options": [
          {
            "id": "200k",
            "label": "200k",
            "isDefault": true
          },
          {
            "id": "1m",
            "label": "1M"
          }
        ]
      }
    ],
    "effortMap": {
      "max": "high",
      "ultrathink": null
    }
  },
  {
    "slug": "claude-haiku-5-5",
    "name": "Haiku 5.5",
    "status": "current",
    "minVersion": "2.1.293",
    "options": [
      {
        "id": "effort",
        "label": "Reasoning",
        "type": "select",
        "options": [
          {
            "id": "low",
            "label": "Low"
          },
          {
            "id": "medium",
            "label": "Medium",
            "isDefault": true
          },
          {
            "id": "high",
            "label": "High"
          },
          {
            "id": "xhigh",
            "label": "Extra High"
          },
          {
            "id": "max",
            "label": "Max"
          },
          {
            "id": "ultrathink",
            "label": "Ultrathink"
          }
        ],
        "promptInjectedValues": [
          "ultrathink"
        ]
      }
    ],
    "effortMap": {
      "ultrathink": null
    }
  },
  {
    "slug": "claude-haiku-4-5",
    "name": "Haiku 4.5",
    "status": "legacy",
    "minVersion": null,
    "options": [
      {
        "id": "thinking",
        "label": "Thinking",
        "type": "boolean",
        "currentValue": true
      }
    ],
    "effortMap": {}
  }
];

/** Codex lists its own models. The catalog only marks which ones are legacy. */
export const codexModelStatus: Record<string, "current" | "legacy"> = {
  "gpt-6.1-sol": "current",
  "gpt-6-astra": "current",
  "gpt-6-luna": "current",
  "gpt-6-sol": "legacy",
  "gpt-5.6-sol": "legacy",
  "gpt-5.6-terra": "legacy",
  "gpt-5.6-luna": "legacy",
  "gpt-5.5": "legacy"
};
