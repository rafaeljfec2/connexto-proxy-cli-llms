import {
  pathCandidates,
  fileContentCandidates,
  oldTextCandidates,
  newTextCandidates,
  shellCommandCandidates,
  shellWorkdirCandidates,
  timeoutCandidates,
  globPatternCandidates,
  globPathCandidates,
} from "./candidates.js";

export * from "./candidates.js";

export function commonArgumentAliases(
  normalized: string,
): Array<{ candidates: string[]; priority: number }> {
  const aliases: Record<string, Array<{ candidates: string[]; priority: number }>> = {
    absolutepath: [{ candidates: pathCandidates(), priority: 80 }],
    commandline: [{ candidates: shellCommandCandidates(), priority: 80 }],
    contents: [{ candidates: [...fileContentCandidates(), "newString"], priority: 70 }],
    command: [{ candidates: shellCommandCandidates(), priority: 90 }],
    shellcommand: [{ candidates: shellCommandCandidates(), priority: 95 }],
    code: [{ candidates: shellCommandCandidates(), priority: 60 }],
    cwd: [{ candidates: shellWorkdirCandidates(), priority: 45 }],
    directory: [
      {
        candidates: [...shellWorkdirCandidates(), ...globPathCandidates()],
        priority: 45,
      },
    ],
    filetext: [{ candidates: [...fileContentCandidates(), "newString"], priority: 95 }],
    filepath: [{ candidates: pathCandidates(), priority: 90 }],
    filename: [{ candidates: pathCandidates(), priority: 75 }],
    fileglob: [{ candidates: globPatternCandidates(), priority: 90 }],
    filepattern: [{ candidates: globPatternCandidates(), priority: 90 }],
    glob: [{ candidates: globPatternCandidates(), priority: 85 }],
    globpattern: [{ candidates: globPatternCandidates(), priority: 95 }],
    includepattern: [{ candidates: globPatternCandidates(), priority: 80 }],
    include: [{ candidates: globPatternCandidates(), priority: 70 }],
    literal: [{ candidates: ["literal", "fixedString", "fixed_string"], priority: 90 }],
    newcontents: [
      {
        candidates: [...newTextCandidates(), ...fileContentCandidates()],
        priority: 85,
      },
    ],
    newstring: [{ candidates: newTextCandidates(), priority: 95 }],
    newtext: [{ candidates: [...newTextCandidates(), "text"], priority: 85 }],
    oldcontents: [{ candidates: [...oldTextCandidates(), "text"], priority: 80 }],
    oldstring: [{ candidates: oldTextCandidates(), priority: 95 }],
    oldtext: [{ candidates: [...oldTextCandidates(), "text"], priority: 85 }],
    pattern: [{ candidates: ["pattern", "query", "regex", "search"], priority: 80 }],
    query: [{ candidates: ["query", "pattern", "search", "prompt"], priority: 80 }],
    regex: [{ candidates: ["pattern", "regex", "query"], priority: 75 }],
    replacement: [{ candidates: newTextCandidates(), priority: 85 }],
    replacewith: [{ candidates: newTextCandidates(), priority: 90 }],
    script: [{ candidates: shellCommandCandidates(), priority: 75 }],
    search: [{ candidates: ["pattern", "query", "oldString", "search"], priority: 70 }],
    searchstring: [
      { candidates: ["pattern", "query", "oldString", "search"], priority: 80 },
    ],
    searchpath: [{ candidates: globPathCandidates(), priority: 80 }],
    targetdirectory: [{ candidates: globPathCandidates(), priority: 55 }],
    target: [{ candidates: pathCandidates(), priority: 80 }],
    targetpath: [{ candidates: pathCandidates(), priority: 90 }],
    targetfile: [{ candidates: pathCandidates(), priority: 90 }],
    targeting: [
      { candidates: ["path", "directory", "cwd", "pattern", "filePath"], priority: 45 },
    ],
    timeout: [{ candidates: timeoutCandidates(), priority: 90 }],
    timeoutms: [{ candidates: timeoutCandidates(), priority: 95 }],
    timeoutmilliseconds: [{ candidates: timeoutCandidates(), priority: 95 }],
    timeoutseconds: [{ candidates: timeoutCandidates(), priority: 95 }],
    seconds: [{ candidates: timeoutCandidates(), priority: 80 }],
    url: [{ candidates: ["url", "uri", "href"], priority: 90 }],
  };
  if (normalized === "workingdirectory" || normalized === "workingdir")
    return [{ candidates: shellWorkdirCandidates(), priority: 90 }];
  if (normalized === "cmd")
    return [{ candidates: shellCommandCandidates(), priority: 95 }];
  if (normalized === "path")
    return [
      { candidates: ["filePath", "path", "directory", "cwd", "pattern"], priority: 75 },
    ];
  if (normalized === "prompt")
    return [
      { candidates: ["prompt", "description", "instructions", "query"], priority: 80 },
    ];
  if (normalized === "tasks")
    return [{ candidates: ["todos", "tasks", "items"], priority: 75 }];
  if (normalized === "todo" || normalized === "items")
    return [{ candidates: ["todos", "items", "tasks"], priority: 70 }];
  return aliases[normalized] ?? [];
}

export function toolSpecificArgumentAliases(
  tool: string,
  normalized: string,
): Array<{ candidates: string[]; priority: number }> {
  if (isGlobLikeToolName(tool)) {
    if (
      [
        "globpattern",
        "fileglob",
        "filepattern",
        "includepattern",
        "glob",
        "include",
        "pattern",
        "query",
      ].includes(normalized)
    ) {
      return [{ candidates: globPatternCandidates(), priority: 98 }];
    }
    if (
      [
        "targeting",
        "targetdirectory",
        "searchpath",
        "basepath",
        "root",
        "rootdir",
        "cwd",
        "directory",
        "path",
      ].includes(normalized)
    ) {
      return [{ candidates: globPathCandidates(), priority: 40 }];
    }
  }
  if (["grep", "search", "searchfiles"].includes(tool)) {
    if (["query", "search", "searchstring", "regex", "pattern"].includes(normalized)) {
      return [{ candidates: ["pattern", "query", "regex", "search"], priority: 95 }];
    }
    if (["globpattern", "glob", "include"].includes(normalized)) {
      return [{ candidates: ["include", "glob", "files", "pattern"], priority: 75 }];
    }
    if (["caseinsensitive", "ignorecase"].includes(normalized)) {
      return [
        {
          candidates: [
            "ignoreCase",
            "ignore_case",
            "caseInsensitive",
            "case_insensitive",
          ],
          priority: 95,
        },
      ];
    }
    if (["literal", "fixedstring"].includes(normalized)) {
      return [{ candidates: ["literal", "fixedString", "fixed_string"], priority: 95 }];
    }
    if (["headlimit", "limit", "maxresults", "maxresult"].includes(normalized)) {
      return [
        {
          candidates: ["limit", "headLimit", "head_limit", "maxResults", "max_results"],
          priority: 90,
        },
      ];
    }
    if (["context", "contextlines"].includes(normalized)) {
      return [
        { candidates: ["context", "contextLines", "context_lines"], priority: 90 },
      ];
    }
    if (["contextbefore", "beforecontext"].includes(normalized)) {
      return [
        {
          candidates: [
            "contextBefore",
            "context_before",
            "beforeContext",
            "before_context",
          ],
          priority: 90,
        },
      ];
    }
    if (["contextafter", "aftercontext"].includes(normalized)) {
      return [
        {
          candidates: [
            "contextAfter",
            "context_after",
            "afterContext",
            "after_context",
          ],
          priority: 90,
        },
      ];
    }
  }
  if (["read", "readfile", "openfile"].includes(tool)) {
    if (
      [
        "targeting",
        "target",
        "targetpath",
        "targetfile",
        "filepath",
        "absolutepath",
        "relativepath",
        "path",
        "file",
      ].includes(normalized)
    ) {
      return [{ candidates: pathCandidates(), priority: 95 }];
    }
  }
  if (["write", "writefile", "createfile"].includes(tool)) {
    if (
      [
        "targeting",
        "target",
        "targetpath",
        "targetfile",
        "filepath",
        "absolutepath",
        "relativepath",
        "path",
        "file",
      ].includes(normalized)
    ) {
      return [{ candidates: pathCandidates(), priority: 95 }];
    }
    if (
      ["newcontents", "contents", "content", "text", "body", "data", "value"].includes(
        normalized,
      )
    ) {
      return [{ candidates: fileContentCandidates(), priority: 95 }];
    }
  }
  if (["edit", "editfile", "replacefile", "searchreplace"].includes(tool)) {
    if (
      [
        "targeting",
        "target",
        "targetpath",
        "targetfile",
        "filepath",
        "absolutepath",
        "relativepath",
        "path",
        "file",
      ].includes(normalized)
    ) {
      return [{ candidates: pathCandidates(), priority: 95 }];
    }
    if (
      [
        "oldstring",
        "oldtext",
        "oldcontents",
        "search",
        "searchstring",
        "find",
        "findtext",
      ].includes(normalized)
    ) {
      return [{ candidates: oldTextCandidates(), priority: 95 }];
    }
    if (
      [
        "newstring",
        "newtext",
        "newcontents",
        "replacement",
        "replace",
        "replacewith",
        "content",
      ].includes(normalized)
    ) {
      return [{ candidates: newTextCandidates(), priority: 95 }];
    }
  }
  if (["bash", "shell", "terminal", "runterminalcmd"].includes(tool)) {
    if (
      ["cmd", "commandline", "command", "script", "shellcommand", "code"].includes(
        normalized,
      )
    ) {
      return [{ candidates: shellCommandCandidates(), priority: 95 }];
    }
    if (
      [
        "workingdirectory",
        "workingdir",
        "cwd",
        "directory",
        "dir",
        "path",
        "workdir",
        "projectroot",
      ].includes(normalized)
    ) {
      return [{ candidates: shellWorkdirCandidates(), priority: 95 }];
    }
    if (
      [
        "timeout",
        "timeoutms",
        "timeoutmilliseconds",
        "timeoutseconds",
        "seconds",
      ].includes(normalized)
    ) {
      return [{ candidates: timeoutCandidates(), priority: 95 }];
    }
  }
  if (["webfetch", "fetch", "web"].includes(tool)) {
    if (["url", "uri", "href"].includes(normalized))
      return [{ candidates: ["url", "uri", "href"], priority: 95 }];
    if (["prompt", "query", "instructions"].includes(normalized)) {
      return [{ candidates: ["prompt", "query", "instructions"], priority: 90 }];
    }
  }
  if (
    ["todowrite", "todo"].includes(tool) &&
    ["todos", "tasks", "items"].includes(normalized)
  ) {
    return [{ candidates: ["todos", "tasks", "items"], priority: 95 }];
  }
  if (tool === "task") {
    if (["prompt", "instructions", "query"].includes(normalized)) {
      return [{ candidates: ["prompt", "description", "instructions"], priority: 90 }];
    }
    if (["subagenttype", "agent", "agenttype"].includes(normalized)) {
      return [{ candidates: ["subagent_type", "subagentType", "agent"], priority: 90 }];
    }
  }
  return [];
}

export function toolNameAliases(normalized: string): string[] {
  const aliases: Record<string, string[]> = {
    createfile: ["write"],
    editfile: ["edit"],
    fileglob: ["glob", "find"],
    filesearch: ["glob", "grep", "find"],
    find: ["glob"],
    findfile: ["glob"],
    findfiles: ["glob", "find"],
    openfile: ["read"],
    readfile: ["read"],
    replacefile: ["edit"],
    runterminalcmd: ["bash", "shell"],
    shell: ["bash"],
    searchfiles: ["grep", "glob"],
    searchreplace: ["edit"],
    terminal: ["bash", "shell"],
    ls: ["list"],
    list: ["ls"],
    mcp: ["callmcptool"],
    writefile: ["write"],
  };
  return aliases[normalized] ?? [];
}

export function isGlobLikeToolName(normalized: string): boolean {
  return [
    "glob",
    "fileglob",
    "filesearch",
    "find",
    "findfile",
    "findfiles",
    "globfiles",
  ].includes(normalized);
}
