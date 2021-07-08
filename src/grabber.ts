import MarkdownIt = require('markdown-it');
import Core = require('markdown-it/lib/parser_core');

export function grabberPlugin(md : MarkdownIt) {
    const grabit : Core.RuleCore = state => {
        if (state.env) {
            state.env.gstate = state;
        }
        return false;
    };

    md.core.ruler.before('normalize', 'grabit', grabit);
};