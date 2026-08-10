import { expect, it, vi } from 'vitest';
import type { PersistedData } from '../../src/domain';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { convertExistingExports } from '../../src/sync/converter';
import {
  CSV_HEADER,
  parseCsvDocument,
  serializeCsvDocument,
} from '../../src/output/csv';
import { parseJsonDocument, serializeJsonDocument } from '../../src/output/json';
import { newNote, renderVisit, stableVisitId } from '../../src/output/markdown';
import { serializeMarkdownDocument } from '../../src/output/markdown';
import { codecFor, type OutputFormat } from '../../src/output/codec';
import { runImport } from '../../src/sync/importer';
import { BrowserSyncOperationAlreadyRunningError } from '../../src/sync/operation-guard';
import { historyDocument, historyRecord } from '../helpers/history-documents';
import { fakeVault, fakeVaultWithRenderedVisit } from '../helpers/fake-vault';
import { visit } from '../helpers/visits';

it('converts managed Markdown to the selected JSON format and keeps the source', async () => {
  const input = visit();
  const vault = fakeVaultWithRenderedVisit(input);

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'keep',
    },
  }, { vault });

  expect(summary).toMatchObject({ converted: 1, retained: 1, failed: [] });
  expect(vault.hasFile('Browser History/2026/2026-08.md')).toBe(true);
  expect(parseJsonDocument(
    vault.readText('Browser History/2026/2026-08.json'),
  ).document.records[0].sync?.id).toBe(stableVisitId(input));
});

it('does not multiply modern or repeated legacy records when rerun', async () => {
  const modern = historyRecord({ timestamp: '2024-07-01T08:56:04+03:00' });
  const legacy = historyRecord({
    timestamp: '2024-07-01T08:57:04+03:00',
    sync: undefined,
  });
  const source = 'Browser History/2024/2024-07.json';
  const target = 'Browser History/2024/2024-07.csv';
  const vault = fakeVault({
    files: {
      [source]: serializeJsonDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          period: '2024-07',
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [modern, legacy, legacy],
      })),
    },
  });
  const request = {
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'csv' as const,
      formatConversionBehavior: 'keep' as const,
    },
  };

  await convertExistingExports(request, { vault });
  await convertExistingExports(request, { vault });

  expect(parseCsvDocument(vault.readText(target)).document.records)
    .toEqual([modern, legacy, legacy]);
});

it('trashes a clean source only after a validated destination write', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const vault = fakeVaultWithRenderedVisit(visit());

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.skippedReplacement).toBe(0);
  expect(vault.hasFile(source)).toBe(false);
  expect(vault.trashedPaths()).toEqual([source]);
});

it('retains Markdown with user content and every source whose destination fails', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const target = 'Browser History/2026/2026-08.json';
  const managedMarkdown = newNote('2026-08', [renderVisit(visit()).trimEnd()]);
  const vault = fakeVault({
    files: { [source]: `${managedMarkdown}\nPrivate note\n` },
    failWrite: target,
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([{ path: target, category: 'write' }]);
  expect(summary.skippedReplacement).toBe(0);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('ignores unmanaged and out-of-folder files but reports recognized invalid sources privately', async () => {
  const validCsv = serializeCsvDocument(historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_csv',
    },
  }));
  const partialSyncCsv = validCsv.replace(
    ',obsidian-browser-sync,chrome,1234567890abcdef12345678',
    ',obsidian-browser-sync,,1234567890abcdef12345678',
  );
  const vault = fakeVault({
    files: {
      'Browser History/bad.json': '{"type":"browser_history","metadata":{"browser_sync":true}',
      'Browser History/bad.csv': partialSyncCsv,
      'Browser History/ordinary.json': '{"private":"do not inspect me"}',
      'Browser History/readme.md': '# Browser history\nPrivate title and URL',
      'Other/bad.json': '{"type":"browser_history","metadata":{"browser_sync":true}',
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'markdown' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: 'Browser History/bad.csv', category: 'invalid-source' },
    { path: 'Browser History/bad.json', category: 'invalid-source' },
  ]);
  expect(summary.failed.every((failure) =>
    Object.keys(failure).sort().join(',') === 'category,path')).toBe(true);
  expect(JSON.stringify(summary)).not.toContain('Private title');
  expect(vault.hasFile('Browser History/ordinary.json')).toBe(true);
  expect(vault.hasFile('Other/bad.json')).toBe(true);
});

it('rejects conflicting sync IDs without changing or removing affected sources', async () => {
  const shared = historyRecord();
  const jsonPath = 'Browser History/source.json';
  const csvPath = 'Browser History/source.csv';
  const target = 'Browser History/2026/2026-08.md';
  const vault = fakeVault({
    files: {
      [jsonPath]: serializeJsonDocument(historyDocument({ records: [shared] })),
      [csvPath]: serializeCsvDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_csv',
        },
        records: [{ ...shared, title: 'Conflicting private title' }],
      })),
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, formatConversionBehavior: 'replace' },
  }, { vault });

  expect(summary.failed).toEqual([{ path: target, category: 'conflict' }]);
  expect(JSON.stringify(summary)).not.toContain('Conflicting private title');
  expect(vault.hasFile(jsonPath)).toBe(true);
  expect(vault.hasFile(csvPath)).toBe(true);
  expect(vault.hasFile(target)).toBe(false);
  expect(vault.trashedPaths()).toEqual([]);
});

it('marks mixed Markdown and CSV provenance deterministically', async () => {
  const markdownRecord = historyRecord({
    timestamp: '2026-08-03T15:34:56+03:00',
  });
  const csvRecord = historyRecord({
    timestamp: '2026-08-03T15:35:56+03:00',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: 'abcdef1234567890abcdef12',
    },
  });
  const vault = fakeVault({
    files: {
      'Browser History/source.md': serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [markdownRecord],
      })),
      'Browser History/source.csv': serializeCsvDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_csv',
        },
        records: [csvRecord],
      })),
    },
  });

  await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  const converted = parseJsonDocument(
    vault.readText('Browser History/2026/2026-08.json'),
  ).document;
  expect(converted.metadata.source_format).toBe('obsidian_browser_sync_mixed');
  expect(converted.records).toEqual([markdownRecord, csvRecord]);
});

it('retains user-authored Markdown after a successful replacement conversion', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const managed = newNote('2026-08', [renderVisit(visit()).trimEnd()]);
  const vault = fakeVault({ files: { [source]: `${managed}\nPrivate note\n` } });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary).toMatchObject({ converted: 1, skippedReplacement: 1 });
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.hasFile('Browser History/2026/2026-08.json')).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it.each(['keep', 'replace'] as const)(
  'never rewrites a Markdown target containing user content in %s mode',
  async (formatConversionBehavior) => {
    const source = 'Browser History/source.json';
    const target = 'Browser History/2026/2026-08.md';
    const targetContent = `${newNote('2026-08', [])}Private target note\n`;
    const vault = fakeVault({
      files: {
        [source]: serializeJsonDocument(historyDocument()),
        [target]: targetContent,
      },
    });

    const summary = await convertExistingExports({
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: 'markdown',
        formatConversionBehavior,
      },
    }, { vault });

    expect(summary.failed).toEqual([
      { path: target, category: 'user-content-destination' },
    ]);
    expect(vault.readText(target)).toBe(targetContent);
    expect(vault.hasFile(source)).toBe(true);
    expect(vault.trashedPaths()).toEqual([]);
  },
);

it.each(['keep', 'replace'] as const)(
  'never rewrites late user content added to a Markdown target in %s mode',
  async (formatConversionBehavior) => {
    const source = 'Browser History/source.json';
    const target = 'Browser History/2026/2026-08.md';
    const initialTarget = newNote('2026-08', []);
    const lateTarget = `${initialTarget}Private target note added during retry\n`;
    const vault = fakeVault({
      files: {
        [source]: serializeJsonDocument(historyDocument()),
        [target]: initialTarget,
      },
      conditionalWriteInterference: {
        path: target,
        contents: [lateTarget],
      },
    });

    const summary = await convertExistingExports({
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: 'markdown',
        formatConversionBehavior,
      },
    }, { vault });

    expect(summary.failed).toEqual([
      { path: target, category: 'user-content-destination' },
    ]);
    expect(vault.readText(target)).toBe(lateTarget);
    expect(vault.hasFile(source)).toBe(true);
    expect(vault.trashedPaths()).toEqual([]);
  },
);

it.each([
  ['markdown', false],
  ['markdown', true],
  ['csv', false],
  ['csv', true],
  ['json', false],
  ['json', true],
] as const)(
  'preserves a %s target whose period changes at the %s boundary',
  async (targetFormat, late) => {
    const sourceFormat = targetFormat === 'markdown' ? 'json' : 'markdown';
    const source = `Browser History/source.${codecFor(sourceFormat).extension.slice(1)}`;
    const target = `Browser History/2026/2026-08.${codecFor(targetFormat).extension.slice(1)}`;
    const wrongTarget = codecFor(targetFormat).serialize(historyDocument({
      metadata: { ...historyDocument().metadata, period: '2026-09' },
      records: [historyRecord({
        timestamp: '2026-09-03T15:34:56+03:00',
        sync: {
          namespace: 'obsidian-browser-sync',
          browser: 'chrome',
          id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        },
      })],
    }));
    const initialTarget = codecFor(targetFormat).serialize(historyDocument({ records: [] }));
    const vault = fakeVault({
      files: {
        [source]: codecFor(sourceFormat).serialize(historyDocument()),
        [target]: late ? initialTarget : wrongTarget,
      },
      ...(late ? {
        conditionalWriteInterference: {
          path: target,
          contents: [wrongTarget],
        },
      } : {}),
    });

    const summary = await convertExistingExports({
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: targetFormat,
        formatConversionBehavior: 'replace',
      },
    }, { vault });

    expect(summary.failed).toContainEqual({
      path: target,
      category: 'routing-collision',
    });
    expect(vault.readText(target)).toBe(wrongTarget);
    expect(vault.hasFile(source)).toBe(true);
    expect(vault.trashedPaths()).toEqual([]);
  },
);

it('reports a read-back failure and does not trash its source', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVaultWithRenderedVisit(visit());
  const read = vault.read.bind(vault);
  vault.read = async (path) => {
    if (path === target) {
      throw new Error(`Private destination failure: ${path}`);
    }
    return await read(path);
  };

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([{ path: target, category: 'read-back' }]);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('rechecks Markdown user content added before replacement', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVaultWithRenderedVisit(visit());
  const read = vault.read.bind(vault);
  vault.read = async (path) => {
    const content = await read(path);
    if (path === target) {
      await vault.append(source, '\nPrivate note added during conversion\n');
    }
    return content;
  };

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.skippedReplacement).toBe(1);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('reports a trash failure after output validation and continues with other sources', async () => {
  const markdownPath = 'Browser History/a.md';
  const csvPath = 'Browser History/b.csv';
  const record = historyRecord();
  const vault = fakeVault({
    failTrash: markdownPath,
    files: {
      [markdownPath]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [record],
      })),
      [csvPath]: serializeCsvDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_csv',
        },
        records: [record],
      })),
    },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([{ path: markdownPath, category: 'trash' }]);
  expect(vault.hasFile('Browser History/2026/2026-08.json')).toBe(true);
  expect(vault.hasFile(markdownPath)).toBe(true);
  expect(vault.hasFile(csvPath)).toBe(false);
  expect(vault.trashedPaths()).toEqual([csvPath]);
});

it('isolates a failed destination from an independent period', async () => {
  const augustSource = 'Browser History/2026/2026-08.md';
  const septemberSource = 'Browser History/2026/2026-09.md';
  const augustTarget = 'Browser History/2026/2026-08.json';
  const septemberVisit = visit({ visitedAt: new Date('2026-09-03T12:34:56Z') });
  const vault = fakeVault({
    failWrite: augustTarget,
    files: {
      [augustSource]: newNote('2026-08', [renderVisit(visit()).trimEnd()]),
      [septemberSource]: newNote('2026-09', [renderVisit(septemberVisit).trimEnd()]),
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([{ path: augustTarget, category: 'write' }]);
  expect(vault.hasFile('Browser History/2026/2026-09.json')).toBe(true);
});

it('does not rewrite a destination that already contains the reconciled result', async () => {
  const vault = fakeVaultWithRenderedVisit(visit());
  const request = {
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' as const },
  };
  await convertExistingExports(request, { vault });
  const write = vi.fn(vault.write.bind(vault));
  vault.write = write;

  const summary = await convertExistingExports(request, { vault });

  expect(summary).toMatchObject({ converted: 0, alreadyCurrent: 1, retained: 1 });
  expect(write).not.toHaveBeenCalled();
});

it('rechecks and merges a destination that appears after the scan', async () => {
  const sourceRecord = historyRecord();
  const concurrentRecord = historyRecord({
    timestamp: '2026-08-03T15:35:56+03:00',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: 'fedcba0987654321fedcba09',
    },
  });
  const source = 'Browser History/source.md';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVault({
    files: {
      [source]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [sourceRecord],
      })),
    },
  });
  const scan = vault.scanFiles.bind(vault);
  vault.scanFiles = async (extensions, callback, root) => {
    await scan(extensions, callback, root);
    await vault.write(target, serializeJsonDocument(historyDocument({
      records: [concurrentRecord],
    })));
  };

  await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(parseJsonDocument(vault.readText(target)).document.records)
    .toEqual([sourceRecord, concurrentRecord]);
});

it('retries and merges a managed destination created at the conditional write', async () => {
  const sourceRecord = historyRecord();
  const concurrentRecord = historyRecord({
    timestamp: '2026-08-03T15:35:56+03:00',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: '111111111111111111111111',
    },
  });
  const source = 'Browser History/source.md';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVault({
    files: {
      [source]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [sourceRecord],
      })),
    },
    conditionalWriteInterference: {
      path: target,
      contents: [serializeJsonDocument(historyDocument({
        records: [concurrentRecord],
      }))],
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([]);
  expect(parseJsonDocument(vault.readText(target)).document.records)
    .toEqual([sourceRecord, concurrentRecord]);
});

it('retries and merges a managed destination modified at the conditional write', async () => {
  const sourceRecord = historyRecord();
  const targetRecord = historyRecord({
    timestamp: '2026-08-03T15:35:56+03:00',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: '222222222222222222222222',
    },
  });
  const concurrentRecord = historyRecord({
    timestamp: '2026-08-03T15:36:56+03:00',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: 'chrome',
      id: '333333333333333333333333',
    },
  });
  const source = 'Browser History/source.md';
  const target = 'Browser History/2026/2026-08.json';
  const initialTarget = historyDocument({ records: [targetRecord] });
  const concurrentTarget = historyDocument({
    records: [targetRecord, concurrentRecord],
  });
  const vault = fakeVault({
    files: {
      [source]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
        records: [sourceRecord],
      })),
      [target]: serializeJsonDocument(initialTarget),
    },
    conditionalWriteInterference: {
      path: target,
      contents: [serializeJsonDocument(concurrentTarget)],
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([]);
  expect(parseJsonDocument(vault.readText(target)).document.records)
    .toEqual([sourceRecord, targetRecord, concurrentRecord]);
});

it('does not overwrite an unmanaged destination created at the conditional write', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVaultWithRenderedVisit(visit(), {
    conditionalWriteInterference: {
      path: target,
      contents: ['Private destination'],
    },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: target, category: 'unmanaged-destination' },
  ]);
  expect(vault.readText(target)).toBe('Private destination');
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('retains affected sources and continues after bounded destination churn', async () => {
  const source = 'Browser History/2026/2026-08.md';
  const independentSource = 'Browser History/2026/2026-09.md';
  const target = 'Browser History/2026/2026-08.json';
  const churn = [
    '444444444444444444444444',
    '555555555555555555555555',
    '666666666666666666666666',
  ].map((id, index) => serializeJsonDocument(historyDocument({
    records: [historyRecord({
      timestamp: `2026-08-03T15:3${index + 5}:56+03:00`,
      sync: { namespace: 'obsidian-browser-sync', browser: 'chrome', id },
    })],
  })));
  const vault = fakeVault({
    files: {
      [source]: newNote('2026-08', [renderVisit(visit()).trimEnd()]),
      [independentSource]: newNote('2026-09', [renderVisit(visit({
        visitedAt: new Date('2026-09-03T12:34:56Z'),
      })).trimEnd()]),
    },
    conditionalWriteInterference: { path: target, contents: churn },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([{ path: target, category: 'concurrency' }]);
  expect(vault.hasFile(source)).toBe(true);
  expect(vault.hasFile('Browser History/2026/2026-09.json')).toBe(true);
  expect(vault.trashedPaths()).toEqual([independentSource]);
});

const singleSourceTransitions = [
  ['markdown', 'csv'],
  ['markdown', 'json'],
  ['csv', 'markdown'],
  ['csv', 'json'],
  ['json', 'markdown'],
  ['json', 'csv'],
] as const satisfies ReadonlyArray<readonly [OutputFormat, OutputFormat]>;

it.each(singleSourceTransitions)(
  'records immediate %s provenance when converting a single source to %s',
  async (sourceFormat, targetFormat) => {
    const source = `Browser History/source.${codecFor(sourceFormat).extension.slice(1)}`;
    const target = `Browser History/2026/2026-08.${codecFor(targetFormat).extension.slice(1)}`;
    const sourceDocument = historyDocument({
      metadata: {
        ...historyDocument().metadata,
        source_format: 'obsidian_browser_sync_browser_database',
      },
    });
    const vault = fakeVault({
      files: { [source]: codecFor(sourceFormat).serialize(sourceDocument) },
    });
    const request = {
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: targetFormat,
        formatConversionBehavior: 'keep' as const,
      },
    };

    const first = await convertExistingExports(request, { vault });
    const second = await convertExistingExports(request, { vault });
    const converted = codecFor(targetFormat).parse(
      vault.readText(target),
      { period: '2026-08' },
    ).document;

    expect(first.failed).toEqual([]);
    expect(second).toMatchObject({ converted: 0, alreadyCurrent: 1, failed: [] });
    expect(converted.records).toEqual(sourceDocument.records);
    expect(converted.metadata.source_format).toBe(
      targetFormat === 'markdown'
        ? 'obsidian_browser_sync_markdown'
        : `obsidian_browser_sync_${sourceFormat}`,
    );
  },
);

it.each(['csv', 'json'] as const)(
  'validates normalized %s-to-Markdown read-back before replacing the direct-import source',
  async (sourceFormat) => {
    const source = `Browser History/2026/2026-08.${sourceFormat}`;
    const target = 'Browser History/2026/2026-08.md';
    const vault = fakeVault({
      files: {
        [source]: codecFor(sourceFormat).serialize(historyDocument({
          metadata: {
            ...historyDocument().metadata,
            source_format: 'obsidian_browser_sync_browser_database',
          },
        })),
      },
    });

    const summary = await convertExistingExports({
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: 'markdown',
        formatConversionBehavior: 'replace',
      },
    }, { vault });

    expect(summary).toMatchObject({ converted: 1, failed: [] });
    expect(vault.hasFile(source)).toBe(false);
    expect(vault.hasFile(target)).toBe(true);
    expect(vault.trashedPaths()).toEqual([source]);
  },
);

it.each([
  ['markdown', 'keep'],
  ['markdown', 'replace'],
  ['json', 'keep'],
  ['json', 'replace'],
] as const)(
  'converts an empty %s document to header-only CSV safely in %s mode and reruns',
  async (sourceFormat, formatConversionBehavior) => {
    const source = `Browser History/source.${sourceFormat === 'markdown' ? 'md' : 'json'}`;
    const target = 'Browser History/2026/2026-08.csv';
    const empty = historyDocument({ records: [] });
    const vault = fakeVault({
      files: { [source]: codecFor(sourceFormat).serialize(empty) },
    });
    const request = {
      settings: {
        ...DEFAULT_SETTINGS,
        outputFormat: 'csv' as const,
        formatConversionBehavior,
      },
    };

    const first = await convertExistingExports(request, { vault });
    const second = await convertExistingExports(request, { vault });

    expect(first.failed).toEqual([]);
    expect(vault.readText(target)).toBe(`${CSV_HEADER.join(',')}\r\n`);
    expect(parseCsvDocument(vault.readText(target), { period: '2026-08' })
      .document.records).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.alreadyCurrent).toBe(1);
    expect(vault.hasFile(source)).toBe(formatConversionBehavior === 'keep');
  },
);

it('infers period context from a managed header-only CSV source and reruns idempotently', async () => {
  const source = 'Browser History/2026/2026-08.csv';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVault({
    files: { [source]: `${CSV_HEADER.join(',')}\r\n` },
  });
  const request = {
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json' as const,
      formatConversionBehavior: 'keep' as const,
    },
  };

  const first = await convertExistingExports(request, { vault });
  const second = await convertExistingExports(request, { vault });

  expect(first.failed).toEqual([]);
  expect(parseJsonDocument(vault.readText(target)).document.records).toEqual([]);
  expect(second).toMatchObject({ converted: 0, alreadyCurrent: 1, failed: [] });
});

it('infers header-only CSV context from fixed text around the configured period token', async () => {
  const source = 'Browser History/2026/Browser history - 2026-08.csv';
  const target = 'Browser History/2026/Browser history - 2026-08.json';
  const vault = fakeVault({
    files: { [source]: `${CSV_HEADER.join(',')}\r\n` },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      fileNameTemplate: 'Browser history - {period}',
      outputFormat: 'json',
    },
  }, { vault });

  expect(summary.failed).toEqual([]);
  expect(parseJsonDocument(vault.readText(target)).document.records).toEqual([]);
});

it('infers one equal period from every token in a repeated-token filename template', async () => {
  const source = 'Browser History/2026/2026-08-2026-08.csv';
  const target = 'Browser History/2026/2026-08-2026-08.json';
  const vault = fakeVault({
    files: { [source]: `${CSV_HEADER.join(',')}\r\n` },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      fileNameTemplate: '{period}-{period}',
      outputFormat: 'json',
    },
  }, { vault });

  expect(summary.failed).toEqual([]);
  expect(parseJsonDocument(vault.readText(target)).document.records).toEqual([]);
});

it('rejects header-only CSV context when the current period kind or managed routing disagrees', async () => {
  const wrongKind = 'Browser History/2026/2026-W32.csv';
  const wrongRoute = 'Browser History/archive/2026-08.csv';
  const vault = fakeVault({
    files: {
      [wrongKind]: `${CSV_HEADER.join(',')}\r\n`,
      [wrongRoute]: `${CSV_HEADER.join(',')}\r\n`,
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'json' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: wrongKind, category: 'invalid-source' },
    { path: wrongRoute, category: 'invalid-source' },
  ]);
  expect(vault.trashedPaths()).toEqual([]);
});

it('writes valid independent destinations but trashes nothing when any managed source is invalid', async () => {
  const valid = 'Browser History/2026/2026-08.md';
  const malformed = 'Browser History/malformed.json';
  const target = 'Browser History/2026/2026-08.json';
  const vault = fakeVault({
    files: {
      [valid]: serializeMarkdownDocument(historyDocument({
        metadata: {
          ...historyDocument().metadata,
          source_format: 'obsidian_browser_sync_markdown',
        },
      })),
      [malformed]: '{"type":"browser_history","metadata":{"browser_sync":true}',
    },
  });

  const summary = await convertExistingExports({
    settings: {
      ...DEFAULT_SETTINGS,
      outputFormat: 'json',
      formatConversionBehavior: 'replace',
    },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: malformed, category: 'invalid-source' },
  ]);
  expect(summary.skippedReplacement).toBe(1);
  expect(vault.hasFile(target)).toBe(true);
  expect(vault.hasFile(valid)).toBe(true);
  expect(vault.hasFile(malformed)).toBe(true);
  expect(vault.trashedPaths()).toEqual([]);
});

it('rejects an invalid ISO week source before it can collide with a valid routed period', async () => {
  const invalid = historyDocument({
    metadata: { ...historyDocument().metadata, period: '2021-W53' },
  });
  const valid = historyDocument({
    metadata: { ...historyDocument().metadata, period: '2022-W01' },
    records: [historyRecord({
      timestamp: '2022-01-03T12:00:00+03:00',
      sync: {
        namespace: 'obsidian-browser-sync',
        browser: 'chrome',
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })],
  });
  const vault = fakeVault({
    files: {
      'Browser History/invalid.json': JSON.stringify(invalid),
      'Browser History/valid.json': serializeJsonDocument(valid),
    },
  });

  const summary = await convertExistingExports({
    settings: { ...DEFAULT_SETTINGS, outputFormat: 'markdown' },
  }, { vault });

  expect(summary.failed).toEqual([
    { path: 'Browser History/invalid.json', category: 'invalid-source' },
  ]);
  expect(vault.hasFile('Browser History/2022/2022-01/2022-W01.md')).toBe(true);
});

it('rejects an import racing conversion and releases the guard afterward', async () => {
  const vault = fakeVault();
  const scan = vault.scanFiles.bind(vault);
  let releaseScan: () => void = () => {};
  const scanPending = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  vault.scanFiles = async (extensions, callback, root) => {
    await scanPending;
    await scan(extensions, callback, root);
  };
  const conversion = convertExistingExports({ settings: DEFAULT_SETTINGS }, { vault });
  const state: PersistedData = {
    version: 3,
    deviceIdentityHash: 'a'.repeat(64),
    settings: DEFAULT_SETTINGS,
    cursors: {},
  };

  const racingImport = runImport({ data: state }, {
    discover: async () => [],
    readVisits: async () => [],
    vault,
    saveData: async () => {},
  });
  releaseScan();

  await expect(racingImport).rejects.toBeInstanceOf(
    BrowserSyncOperationAlreadyRunningError,
  );
  await conversion;
  await expect(convertExistingExports({ settings: DEFAULT_SETTINGS }, {
    vault: fakeVault(),
  })).resolves.toMatchObject({ failed: [] });
});

it('releases the guard when scanning throws', async () => {
  const brokenVault = fakeVault();
  brokenVault.scanFiles = async () => {
    throw new Error('Private scan failure');
  };

  await expect(convertExistingExports({ settings: DEFAULT_SETTINGS }, {
    vault: brokenVault,
  })).rejects.toThrow('Private scan failure');
  await expect(convertExistingExports({ settings: DEFAULT_SETTINGS }, {
    vault: fakeVault(),
  })).resolves.toMatchObject({ failed: [] });
});
