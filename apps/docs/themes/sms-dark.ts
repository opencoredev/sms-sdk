// Shiki theme for dark mode, from the landing page's code colors. Generated as JSON-shaped data.
export default {
  "name": "sms-dark",
  "type": "dark",
  "colors": {
    "editor.background": "#181715",
    "editor.foreground": "#d6d2c9"
  },
  "tokenColors": [
    {
      "settings": {
        "foreground": "#d6d2c9"
      }
    },
    {
      "scope": [
        "comment",
        "punctuation.definition.comment"
      ],
      "settings": {
        "foreground": "#8a867d"
      }
    },
    {
      "scope": [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.control.import",
        "keyword.control.from",
        "keyword.control.export"
      ],
      "settings": {
        "foreground": "#d39e8a"
      }
    },
    {
      "scope": [
        "string",
        "string.quoted",
        "string.template",
        "punctuation.definition.string"
      ],
      "settings": {
        "foreground": "#cdbb8c"
      }
    },
    {
      "scope": [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function"
      ],
      "settings": {
        "foreground": "#b7c7d6"
      }
    },
    {
      "scope": [
        "variable.other.property",
        "meta.object-literal.key",
        "support.type.property-name",
        "variable.other.object.property"
      ],
      "settings": {
        "foreground": "#a9b8a0"
      }
    },
    {
      "scope": [
        "constant.numeric",
        "constant.language",
        "support.constant",
        "constant.other"
      ],
      "settings": {
        "foreground": "#d8c79b"
      }
    },
    {
      "scope": [
        "entity.name.type",
        "support.type",
        "entity.name.class"
      ],
      "settings": {
        "foreground": "#b7c7d6"
      }
    },
    {
      "scope": [
        "markup.inserted"
      ],
      "settings": {
        "foreground": "#a9b8a0"
      }
    },
    {
      "scope": [
        "markup.deleted"
      ],
      "settings": {
        "foreground": "#d39e8a"
      }
    }
  ]
} as const;
