/**
 * The page script's code color: a small tokenizer for CSS, JSON, HTML, and JS (no library). It reads the text of a
 * `pre.snip[data-lang]` and rebuilds the `<code>` from text nodes and `<span class="sx-…">` elements, so nothing is
 * ever parsed as HTML: whatever the text holds is shown as it is. The colors are in the page's CSS, from the system's own
 * `color.code.*` tokens. Without the script, the text stays plain. (`String.raw`, so that the regular expressions keep
 * their backslashes.)
 */
export const JS_CODE = String.raw`    // Code color. A rule is [class, /pattern/]; the first rule that matches at a place wins, so the order is the priority.
    var STR = /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/;
    var NUM = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:%|[a-zA-Z]{1,4})?/;
    var NAME = /-*[A-Za-z_][\w-]*/;
    var CSS_RULES = [
        ["c", /\/\*[\s\S]*?(?:\*\/|$)/],
        ["s", STR],
        ["k", /@[\w-]+/],
        ["n", /#[0-9a-fA-F]{3,8}\b/],
        ["f", new RegExp(NAME.source + "(?=\\()")],
        ["p", new RegExp("--[\\w-]+|" + NAME.source + "(?=\\s*:(?!:))")],
        ["t", /\.[A-Za-z_][\w-]*|::?[A-Za-z][\w-]*/],
        ["", NAME],
        ["n", new RegExp("\\.?" + NUM.source)]
    ];
    var HTML_COMMENT = ["c", /<!--[\s\S]*?(?:-->|$)/];
    var HTML_TAG = ["t", /<\/?[A-Za-z][\w-]*/];
    var HTML_ATTRIBUTE = ["p", /[A-Za-z_:@][\w:.-]*(?==)/];
    var LANGS = {
        css: CSS_RULES,
        web: [HTML_COMMENT, HTML_TAG, CSS_RULES[0], CSS_RULES[1], HTML_ATTRIBUTE].concat(CSS_RULES.slice(2)),
        json: [
            ["p", /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
            ["s", /"(?:[^"\\\n]|\\.)*"?/],
            ["k", /\b(?:true|false|null)\b/],
            ["n", new RegExp("-?" + NUM.source)]
        ],
        js: [
            ["c", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/],
            ["s", new RegExp(STR.source + "|\x60(?:[^\x60\\\\]|\\\\.)*\x60?")],
            ["k", /\b(?:const|let|var|function|return|if|else|for|while|import|export|from|default|new|await|async|class|true|false|null|undefined|typeof|of|in)\b/],
            ["f", /[A-Za-z_$][\w$]*(?=\()/],
            ["t", /\b[A-Z][\w$]*/],
            ["", /[A-Za-z_$][\w$]*/],
            ["n", NUM]
        ]
    };
    var compiled = {};

    function tokenizer(lang) {
        if (!LANGS[lang]) { return null; }
        if (!compiled[lang]) {
            compiled[lang] = {
                classes: LANGS[lang].map(function (rule) { return rule[0]; }),
                regex: new RegExp(LANGS[lang].map(function (rule) { return "(" + rule[1].source + ")"; }).join("|"), "g")
            };
        }
        return compiled[lang];
    }

    // The text as a fragment of text nodes and spans. A pattern that matches nothing cannot loop: the regex always
    // moves forward, and a zero-width match is skipped.
    function colorize(text, lang) {
        var tk = tokenizer(lang);
        var out = document.createDocumentFragment();
        function put(piece, cls) {
            if (!piece) { return; }
            if (!cls) { out.appendChild(document.createTextNode(piece)); return; }
            var span = document.createElement("span");
            span.className = "sx-" + cls;
            span.textContent = piece;
            out.appendChild(span);
        }
        if (!tk) { put(text, ""); return out; }
        var at = 0, match;
        tk.regex.lastIndex = 0;
        while ((match = tk.regex.exec(text)) !== null) {
            if (match[0] === "") { tk.regex.lastIndex++; continue; }
            var index = 1;
            while (match[index] === undefined) { index++; }
            put(text.slice(at, match.index), "");
            put(match[0], tk.classes[index - 1]);
            at = match.index + match[0].length;
        }
        put(text.slice(at), "");
        return out;
    }

    $$("pre.snip[data-lang]").forEach(function (block) {
        var code = $("code", block);
        // A very long text stays plain: color is for a screenful of code, not a file.
        if (!code || code.textContent.length > 20000) { return; }
        var text = code.textContent;
        code.textContent = "";
        code.appendChild(colorize(text, block.getAttribute("data-lang")));
        block.setAttribute("data-colored", "");
    });

`;
