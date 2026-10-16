import { analyze, type AnalyzeOptions } from './diagnostics';
import { canonicalKeyword, isKnownKeyword } from './keywords';
import type { SshConfigDocument, SshDirective, SshHost, SshItem } from './model';
import { commentText } from './serialize';
import type { HostSummary, ViewDocument, ViewHost, ViewOption } from '../shared/protocol';
import { isConcreteAlias } from '../shared/validation';

const SUMMARY_FIELDS: Record<string, keyof HostSummary> = {
  hostname: 'hostName',
  user: 'user',
  port: 'port',
  identityfile: 'identityFile',
  proxyjump: 'proxyJump',
  forwardagent: 'forwardAgent',
};

function toViewOption(d: SshDirective): ViewOption {
  const option: ViewOption = { keyword: d.keyword, value: d.value };
  if (d.disabled) {
    option.disabled = true;
  }
  if (!isKnownKeyword(d.keyword)) {
    option.unknown = true;
  }
  return option;
}

const directives = (items: SshItem[]): SshDirective[] => items.filter((i): i is SshDirective => i.type === 'directive');

/** First value of each card field; ssh uses the first value it finds for an option. */
function summarize(host: SshHost): HostSummary {
  const summary: HostSummary = {};
  for (const d of directives(host.items)) {
    if (d.disabled && !host.disabled) {
      continue;
    }
    const field = SUMMARY_FIELDS[(canonicalKeyword(d.keyword) ?? d.keyword).toLowerCase()];
    if (field && summary[field] === undefined) {
      summary[field] = d.value;
    }
  }
  return summary;
}

function toViewHost(host: SshHost): ViewHost {
  const view: ViewHost = {
    kind: host.kind,
    patterns: host.patterns,
    aliases: host.kind === 'host' ? host.patterns.split(/\s+/).filter(isConcreteAlias) : [],
    comment: commentText(host.comment),
    options: directives(host.items).map(toViewOption),
    summary: summarize(host),
  };
  if (host.disabled) {
    view.disabled = true;
  }
  return view;
}

export function toViewDocument(doc: SshConfigDocument, options: AnalyzeOptions = {}): ViewDocument {
  const view: ViewDocument = {
    global: directives(doc.global).map(toViewOption),
    groups: doc.groups.map((group) => ({
      name: group.name,
      comment: commentText(group.comment),
      hosts: group.items.filter((i): i is SshHost => i.type === 'host').map(toViewHost),
    })),
  };
  for (const problem of analyze(doc, options)) {
    if (problem.ref && problem.kind !== 'unknown-option') {
      const host = view.groups[problem.ref.group]?.hosts[problem.ref.index];
      if (host) {
        host.warnings = [...(host.warnings ?? []), problem.message];
      }
    }
  }
  return view;
}
