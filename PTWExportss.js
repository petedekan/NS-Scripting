/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */

define(['N/search', 'N/file', 'N/log'], function(search, file, log) {
    function execute(context) {
        try {
            log.audit('Saved Search Export', 'Starting export of saved searches');

            var results = [];
            var query = search.create({
                type: 'savedsearch',
                filters: [['isinactive', 'is', 'F']],
                columns: [
                    'internalid', 'title', 'frombundle', 'id', 'recordtype',
                    'owner', 'access', 'exportcsv', 'persistcsv',
                    'sendscheduledemails', 'lastrunby', 'lastrunon'
                ]
            });

            var paged = query.runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach(function(pageRange) {
                var page = paged.fetch({ index: pageRange.index });
                page.data.forEach(function(res) {
                    var item = {
                        internalId: res.getValue('internalid'),
                        title: res.getValue('title') || '',
                        searchId: res.getValue('id') || ('customsearch' + res.getValue('internalid')),
                        fromBundle: res.getValue('frombundle') || 'No',
                        recordType: res.getText('recordtype') || '',
                        owner: res.getText('owner') || res.getValue('owner') || '',
                        accessLevel: res.getValue('access') || '',
                        exportCsv: res.getValue('exportcsv') || '',
                        persistCsv: res.getValue('persistcsv') || '',
                        scheduled: res.getValue('sendscheduledemails') || '',
                        lastRunBy: res.getText('lastrunby') || '',
                        lastRunOn: res.getValue('lastrunon') || '',
                        filterCount: 0,
                        columnCount: 0,
                        criteria: '',
                        columnsDesc: ''
                    };

                    try {
                        var loaded = search.load({ id: item.searchId });
                        item.filterCount = loaded.filters ? loaded.filters.length : 0;
                        item.criteria = describeFilters(loaded.filters);
                        item.columnCount = loaded.columns ? loaded.columns.length : 0;
                        item.columnsDesc = describeColumns(loaded.columns);
                        if (loaded.searchType) {
                            item.recordType = loaded.searchType;
                        }
                    } catch (e) {
                        item.criteria = 'Load error: ' + e.message;
                        item.columnsDesc = 'Load error: ' + e.message;
                    }

                    results.push(item);
                });
            });

            log.audit('Saved Search Export', 'Collected ' + results.length + ' searches');

            var headers = [
                'Internal ID','Title','Search ID','From Bundle','Record Type','Owner',
                'Access Level','Export CSV','Persist CSV','Scheduled',
                'Last Run By','Last Run On','Filter Count','Column Count','Criteria','Columns'
            ];
            var csv = [headers.join(',')];

            results.forEach(function(r) {
                csv.push([
                    '"' + r.internalId + '"',
                    '"' + r.title.replace(/"/g, '""') + '"',
                    '"' + r.searchId + '"',
                    '"' + r.fromBundle + '"',
                    '"' + r.recordType + '"',
                    '"' + r.owner + '"',
                    '"' + r.accessLevel + '"',
                    '"' + r.exportCsv + '"',
                    '"' + r.persistCsv + '"',
                    '"' + r.scheduled + '"',
                    '"' + r.lastRunBy + '"',
                    '"' + r.lastRunOn + '"',
                    '"' + r.filterCount + '"',
                    '"' + r.columnCount + '"',
                    '"' + r.criteria.replace(/"/g, '""') + '"',
                    '"' + r.columnsDesc.replace(/"/g, '""') + '"'
                ].join(','));
            });

            var fileObj = file.create({
                name: 'SavedSearchList_' + new Date().getTime() + '.csv',
                fileType: file.Type.CSV,
                contents: csv.join('\n'),
                folder: -15
            });
            var fileId = fileObj.save();
            log.audit('Saved Search Export', 'Export file created with ID ' + fileId);

        } catch (err) {
            log.error('Saved Search Export', err);
        }
    }

    function describeFilters(filters) {
        if (!filters || filters.length === 0) return 'No criteria';
        return filters.map(function(f, i) {
            var txt = (i + 1) + '. ';
            if (f.join) txt += f.join + '.';
            txt += f.name || 'unknown';
            txt += ' ' + (f.operator || 'equals');
            if (f.values && f.values.length) {
                txt += ' [' + f.values.slice(0, 3).join(', ') + ']';
            }
            return txt;
        }).join(' | ');
    }

    function describeColumns(columns) {
        if (!columns || columns.length === 0) return 'No columns';
        return columns.map(function(c, i) {
            var txt = (i + 1) + '. ';
            if (c.join) txt += c.join + '.';
            txt += c.name || 'unknown';
            if (c.label) txt += ' (' + c.label + ')';
            if (c.summary) txt += ' [' + c.summary + ']';
            return txt;
        }).join(' | ');
    }

    return { execute: execute };
});

