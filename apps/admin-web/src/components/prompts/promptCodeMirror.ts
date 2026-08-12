import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import type { PromptVariableDefinition } from "../../types";

export function formatPromptVariable(name: string) {
  return `@{${name}}`;
}

export function promptVariableToken(name: string, semanticXml: boolean) {
  const token = formatPromptVariable(name);
  if (!semanticXml) return token;
  const normalized = name.replace(/[^A-Za-z0-9_-]+/g, "_");
  const tag = /^[A-Za-z_]/.test(normalized) ? normalized : `variable_${normalized}`;
  return `<${tag}>${token}</${tag}>`;
}

export function createPromptVariableCompletionSource(
  variables: readonly PromptVariableDefinition[],
  semanticXml: boolean
): CompletionSource {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);
    const at = before.lastIndexOf("@");
    if (at < 0) {
      if (!context.explicit) return null;
      return {
        from: context.pos,
        options: variables.slice(0, 8).map((variable) => ({
          label: formatPromptVariable(variable.name),
          detail: variable.description,
          info: `${variable.type} · ${variable.source}`,
          type: "variable",
          apply: promptVariableToken(variable.name, semanticXml)
        }))
      };
    }

    const fragment = before.slice(at);
    if (fragment.includes("}")) return null;
    const query = fragment.slice(fragment.startsWith("@{") ? 2 : 1).trim().toLocaleLowerCase();
    const matches = (query
      ? variables.filter((variable) => `${variable.name} ${variable.description}`.toLocaleLowerCase().includes(query))
      : variables
    ).slice(0, 8);
    if (!matches.length) return null;

    return {
      from: line.from + at,
      filter: false,
      options: matches.map((variable) => ({
        label: formatPromptVariable(variable.name),
        detail: variable.description,
        info: `${variable.type} · ${variable.source}`,
        type: "variable",
        apply: promptVariableToken(variable.name, semanticXml)
      }))
    };
  };
}

const promptTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "var(--prompt-editor-min-height)",
    backgroundColor: "transparent",
    color: "rgb(var(--color-ink))",
    fontFamily: '"Space Mono", monospace',
    fontSize: "13px",
    fontVariantLigatures: "none"
  },
  "&.cm-focused": {
    outline: "1px solid rgb(var(--color-display))",
    outlineOffset: "-1px"
  },
  ".cm-scroller": {
    overflow: "auto",
    scrollbarGutter: "stable",
    lineHeight: "1.6"
  },
  ".cm-content": {
    minWidth: "0",
    padding: "20px 0",
    caretColor: "rgb(var(--color-accent))"
  },
  ".cm-line": {
    padding: "0 24px 0 12px"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "rgb(var(--color-accent))"
  },
  ".cm-gutters": {
    minWidth: "48px",
    borderRight: "1px solid rgb(var(--color-line))",
    backgroundColor: "rgb(var(--color-raised) / 0.72)",
    color: "rgb(var(--color-mute))"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "36px",
    padding: "0 10px 0 8px",
    fontSize: "11px"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "rgb(var(--color-raised) / 0.64)"
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgb(var(--color-accent) / 0.18)",
    color: "rgb(var(--color-display))"
  },
  ".cm-panels": {
    borderColor: "rgb(var(--color-line))",
    backgroundColor: "rgb(var(--color-panel))",
    color: "rgb(var(--color-ink))"
  },
  ".cm-searchMatch": {
    outline: "1px solid rgb(var(--color-warning))",
    backgroundColor: "rgb(var(--color-warning) / 0.16)"
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "rgb(var(--color-accent) / 0.18)"
  },
  ".cm-tooltip": {
    border: "1px solid rgb(var(--color-visible))",
    borderRadius: "4px",
    backgroundColor: "rgb(var(--color-panel))",
    color: "rgb(var(--color-ink))"
  },
  ".cm-tooltip-autocomplete > ul": {
    maxHeight: "288px",
    fontFamily: '"Space Mono", monospace'
  },
  ".cm-tooltip-autocomplete > ul > li": {
    minHeight: "36px",
    padding: "8px 12px"
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "rgb(var(--color-raised))",
    color: "rgb(var(--color-ink))"
  },
  ".cm-completionLabel": {
    color: "rgb(var(--color-display))"
  },
  ".cm-completionDetail": {
    marginLeft: "12px",
    color: "rgb(var(--color-mute))",
    fontStyle: "normal"
  },
  ".cm-prompt-variable": {
    borderRadius: "2px",
    backgroundColor: "rgb(var(--color-accent) / 0.08)",
    color: "rgb(var(--color-accent))"
  },
  ".cm-prompt-directive": {
    color: "rgb(var(--color-warning))"
  },
  ".cm-prompt-condition": {
    color: "rgb(var(--color-display))"
  }
});

const promptHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "rgb(var(--color-ink))" },
  { tag: [tags.emphasis, tags.quote], color: "rgb(var(--color-mute))" },
  { tag: [tags.strong, tags.link, tags.url], color: "rgb(var(--color-display))" },
  { tag: [tags.meta, tags.punctuation, tags.angleBracket], color: "rgb(var(--color-accent))" },
  { tag: [tags.tagName, tags.attributeName], color: "rgb(var(--color-accent))" },
  { tag: [tags.string, tags.number, tags.bool, tags.null], color: "rgb(var(--color-display))" },
  { tag: [tags.keyword, tags.operator], color: "rgb(var(--color-warning))" },
  { tag: tags.monospace, color: "rgb(var(--color-accent))" }
]);

const directiveDecorator = new MatchDecorator({
  regexp: /s-if="([^"\n]*)"/g,
  decorate(add, from, to, match) {
    const quoteOffset = match[0].indexOf('"');
    const conditionFrom = from + quoteOffset + 1;
    add(from, conditionFrom, Decoration.mark({ class: "cm-prompt-directive" }));
    add(conditionFrom, to - 1, Decoration.mark({ class: "cm-prompt-condition" }));
    add(to - 1, to, Decoration.mark({ class: "cm-prompt-directive" }));
  }
});

const promptDirectiveHighlight = ViewPlugin.fromClass(class {
  decorations;

  constructor(view: EditorView) {
    this.decorations = directiveDecorator.createDeco(view);
  }

  update(update: Parameters<typeof directiveDecorator.updateDeco>[0]) {
    this.decorations = directiveDecorator.updateDeco(update, this.decorations);
  }
}, {
  decorations: (plugin) => plugin.decorations
});

export const promptEditorBaseExtensions: readonly Extension[] = [
  basicSetup,
  markdown({ base: markdownLanguage, completeHTMLTags: true }),
  autocompletion({ activateOnTyping: true }),
  keymap.of([indentWithTab]),
  EditorState.tabSize.of(2),
  indentUnit.of("  "),
  EditorView.lineWrapping,
  syntaxHighlighting(promptHighlightStyle),
  promptTheme,
  promptDirectiveHighlight
];

export function promptEditorAttributes(label: string): Extension {
  return EditorView.contentAttributes.of({
    "aria-label": label,
    "aria-multiline": "true",
    autocapitalize: "off",
    spellcheck: "false"
  });
}

export function promptVariableExtensions(
  variables: readonly PromptVariableDefinition[],
  semanticXml: boolean
): readonly Extension[] {
  const availableNames = new Set(variables.map((variable) => variable.name));
  const variableDecorator = new MatchDecorator({
    regexp: /@\{\s*([A-Za-z_][\w.-]*)\s*\}/g,
    decoration: (match) => availableNames.has(match[1] ?? "")
      ? Decoration.mark({ class: "cm-prompt-variable" })
      : null
  });
  const variableHighlight = ViewPlugin.fromClass(class {
    decorations;

    constructor(view: EditorView) {
      this.decorations = variableDecorator.createDeco(view);
    }

    update(update: Parameters<typeof variableDecorator.updateDeco>[0]) {
      this.decorations = variableDecorator.updateDeco(update, this.decorations);
    }
  }, {
    decorations: (plugin) => plugin.decorations
  });
  const completionSource = createPromptVariableCompletionSource(variables, semanticXml);

  return [
    variableHighlight,
    EditorState.languageData.of(() => [{ autocomplete: completionSource }])
  ];
}
