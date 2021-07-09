import MarkdownIt = require('markdown-it');
import Core = require('markdown-it/lib/parser_core');

export function grabberPlugin(md : MarkdownIt) {
    const grabit : Core.RuleCore = state => {
        if (state.env) {
            /* grab the state */
            state.env.gstate = state;
        }
        /* return false to allow next rule to process */
        return false;
    };

    md.core.ruler.before('normalize', 'grabit', grabit);
};
