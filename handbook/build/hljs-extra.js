/* Extra highlight.js languages the handbook uses that highlight.js does not ship:
 * HCL (Terraform), Rego (OPA policies) and PromQL. Small grammars: keywords,
 * strings, comments, numbers, attributes and functions are enough for reading.
 */
module.exports = function registerExtra(hljs) {
  const DQ_STRING = {
    className: 'string', begin: '"', end: '"',
    contains: [hljs.BACKSLASH_ESCAPE, { className: 'subst', begin: /\$\{/, end: /\}/ }],
  };

  hljs.registerLanguage('hcl', () => ({
    name: 'HCL',
    aliases: ['terraform', 'tf'],
    keywords: {
      keyword: 'resource data variable output locals module provider terraform backend required_providers ' +
        'required_version moved import removed check dynamic content lifecycle for in if for_each count depends_on',
      literal: 'true false null',
      built_in: 'var local module data each self path count',
    },
    contains: [
      hljs.HASH_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      { className: 'string', begin: /<<-?\s*([A-Z_]+)\s*$/, end: /^\s*[A-Z_]+\s*$/ },
      DQ_STRING,
      { className: 'attr', begin: /\b[A-Za-z_][\w-]*(?=\s*=(?!=))/ },
      { className: 'title.function', begin: /\b[a-z_][a-z0-9_]*(?=\()/ },
      hljs.NUMBER_MODE,
    ],
  }));

  hljs.registerLanguage('rego', () => ({
    name: 'Rego',
    keywords: {
      keyword: 'package import default not with as some every in if contains else',
      literal: 'true false null',
      built_in: 'input data count sum max min sprintf startswith endswith concat lower upper trim split ' +
        'object array set to_number is_string is_number time regex json',
    },
    contains: [
      hljs.HASH_COMMENT_MODE,
      DQ_STRING,
      { className: 'string', begin: '`', end: '`' },
      { className: 'title.function', begin: /\b[a-z_][a-z0-9_.]*(?=\()/ },
      { className: 'operator', begin: /:=|==|!=|<=|>=/ },
      hljs.NUMBER_MODE,
    ],
  }));

  hljs.registerLanguage('promql', () => ({
    name: 'PromQL',
    keywords: {
      keyword: 'by without on ignoring group_left group_right offset bool and or unless',
      built_in: 'rate irate increase delta idelta sum avg max min count count_values stddev stdvar topk bottomk ' +
        'quantile histogram_quantile abs ceil floor round clamp_min clamp_max absent absent_over_time ' +
        'avg_over_time max_over_time min_over_time sum_over_time count_over_time quantile_over_time ' +
        'label_replace label_join time vector scalar sort sort_desc predict_linear deriv changes resets',
    },
    contains: [
      hljs.HASH_COMMENT_MODE,
      DQ_STRING,
      { className: 'string', begin: "'", end: "'" },
      { className: 'number', begin: /\[\d+[smhdwy]\]|\b\d+(\.\d+)?[smhdwy]?\b/ },
      { className: 'attr', begin: /\b[a-zA-Z_][\w]*(?=\s*(=~|!~|!=|=))/ },
      { className: 'operator', begin: /=~|!~|!=|==|>=|<=/ },
    ],
  }));
};
