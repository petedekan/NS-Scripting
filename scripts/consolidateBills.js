/**
 * Consolidate Bills Script
 * Updated script with improved receipt parsing.
 */

/**
 * @NApiVersion 2.x
 * @NScriptType WorkflowActionScript
 */

define(['N/search', 'N/record', 'N/log', 'N/format', 'N/runtime'], function(search, record, log, format, runtime) {

    const LINDEN_LOCATION_ID = 1;

    function onAction(context) {
        log.audit({ title: 'Consolidate Bills Started', details: 'Starting consolidation process' });
        try {
            var currentBillRecord = context.newRecord;
            var currentBillId = currentBillRecord.id;
            var currentBillRef = currentBillRecord.getValue({ fieldId: 'tranid' });
            if (String(currentBillRef || '').indexOf('CONSOLIDATED-') === 0) {
                log.error({ title: 'Already Consolidated', details: 'This bill is already consolidated.' });
                return 'ERROR: This bill is already consolidated.';
            }

            var poId = getPoId(currentBillRecord);
            if (!poId) {
                log.error({ title: 'PO Not Found', details: 'Could not determine PO from bill lines' });
                return 'ERROR: Could not determine PO from bill lines.';
            }

            var poRecord = record.load({ type: record.Type.PURCHASE_ORDER, id: poId, isDynamic: false });
            var poNumber = (poRecord.getValue({ fieldId: 'tranid' }) || '').replace(/^PO/, '');

            var allBills = findAllBillsForPO(poId);
            if (allBills.length <= 1) {
                return 'SUCCESS: Only one bill exists for PO ' + poNumber + '. No consolidation needed.';
            }

            var consolidationInfo = {
                poId: poId,
                poNumber: poNumber,
                receipts: [],
                totalPPV: 0,
                ppvDetails: [],
                lineItems: [] // store item/qty per original bill line
            };
            var billsToConsolidate = [];
            var billsSkipped = [];

            for (var i = 0; i < allBills.length; i++) {
                var include = false;
                try {
                    var billRec = record.load({ type: record.Type.VENDOR_BILL, id: allBills[i].id, isDynamic: false });
                    var lineCount = billRec.getLineCount({ sublistId: 'item' });
                    for (var l = 0; l < lineCount; l++) {
                        var val = billRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_cc_con_bill', line: l });
                        if (val === true || val === 'T') { include = true; break; }
                    }
                    if (include) {
                        billsToConsolidate.push(allBills[i]);
                        var billData = extractCompleteBillData(allBills[i].id);
                        consolidationInfo.receipts = consolidationInfo.receipts.concat(billData.receipts);
                        consolidationInfo.lineItems = consolidationInfo.lineItems.concat(billData.lineItems);
                        if (billData.ppvDetails) {
                            consolidationInfo.ppvDetails.push({
                                receiptTranId: billData.receiptTranId,
                                details: billData.ppvDetails
                            });
                        }
                    } else {
                        billsSkipped.push(allBills[i]);
                    }
                } catch (e) {
                    log.error({ title: 'Error Checking custcol_cc_con_bill', details: 'Bill ID ' + allBills[i].id + ': ' + e.toString() });
                }
            }

            if (billsToConsolidate.length <= 1) {
                return 'SUCCESS: Only ' + billsToConsolidate.length + ' bill eligible for consolidation.';
            }

            consolidationInfo.receipts = removeDuplicateReceipts(consolidationInfo.receipts);

            var deletedBills = [];
            var deleteErrors = [];
            for (var j = 0; j < billsToConsolidate.length; j++) {
                try {
                    record.delete({ type: record.Type.VENDOR_BILL, id: billsToConsolidate[j].id });
                    deletedBills.push(billsToConsolidate[j].id);
                } catch (delErr) {
                    deleteErrors.push('Bill ' + billsToConsolidate[j].id + ': ' + delErr.message);
                }
            }
            if (deleteErrors.length) {
                return 'ERROR: Failed to delete some bills. ' + deleteErrors.join('; ');
            }

            var consolidatedBillId = createConsolidatedBill(consolidationInfo);
            if (!consolidatedBillId) {
                return 'ERROR: Deleted bills but failed to create consolidated bill.';
            }

            return 'SUCCESS: Consolidated ' + billsToConsolidate.length + ' bills into new bill ID ' + consolidatedBillId + '.';
        } catch (e) {
            log.error({ title: 'Consolidation Error', details: e.toString() });
            return 'ERROR: ' + e.message;
        }
    }

    function getPoId(billRecord) {
        try {
            var lineCount = billRecord.getLineCount({ sublistId: 'item' });
            if (lineCount > 0) {
                var poId = billRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_cc_vb_po_link', line: 0 });
                if (poId) return poId;
            }
            var createdFrom = billRecord.getValue({ fieldId: 'createdfrom' });
            return createdFrom || null;
        } catch (e) {
            log.error({ title: 'Get PO ID Error', details: e.toString() });
            return null;
        }
    }

    function findAllBillsForPO(poId) {
        var allBills = [];
        try {
            var billSearch = search.create({
                type: search.Type.VENDOR_BILL,
                filters: [
                    ['custcol_cc_vb_po_link', 'anyof', poId], 'AND', ['mainline', 'is', 'F']
                ],
                columns: ['internalid', 'tranid', 'total', 'trandate']
            });
            var processed = {};
            billSearch.run().each(function(res) {
                var billId = res.getValue('internalid');
                if (!processed[billId]) {
                    allBills.push({ id: billId, tranid: res.getValue('tranid') });
                    processed[billId] = true;
                }
                return true;
            });
        } catch (e) {
            log.error({ title: 'Search Error', details: e.toString() });
        }
        return allBills;
    }

    function parseMultiSelect(value) {
        if (Array.isArray(value)) return value;
        if (value == null || value === '') return [];
        if (typeof value === 'string') {
            return value.split(/[,\u0005]/).map(function(v){ return v.trim(); }).filter(function(v){ return v; });
        }
        return [value];
    }

    function extractCompleteBillData(billId) {
        try {
            var billRecord = record.load({ type: record.Type.VENDOR_BILL, id: billId, isDynamic: false });
            var billTranId = billRecord.getValue({ fieldId: 'tranid' });
            var receiptTranId = extractReceiptNumber(billTranId);
            var receipts = [];
            var receiptMap = {};
            var lineItems = [];

            var lineCount = billRecord.getLineCount({ sublistId: 'item' });
            for (var i = 0; i < lineCount; i++) {
                var itemId = billRecord.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                var quantity = billRecord.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
                var lineReceiptIds = billRecord.getSublistValue({ sublistId: 'item', fieldId: 'billreceipts', line: i });
                var receiptArray = parseMultiSelect(lineReceiptIds);

                lineItems.push({ itemId: itemId, quantity: quantity, receipts: receiptArray, receiptTranId: receiptTranId });

                receiptArray.forEach(function(rid){
                    if (!receiptMap[rid]) {
                        receipts.push({ id: rid, tranid: receiptTranId });
                        receiptMap[rid] = true;
                    }
                });
            }
            var ppvDetails = billRecord.getValue({ fieldId: 'custbody_total_ppv' }) || '';
            return {
                billId: billId,
                billTranId: billTranId,
                receiptTranId: receiptTranId,
                receipts: receipts,
                ppvDetails: ppvDetails,
                lineItems: lineItems
            };
        } catch (e) {
            log.error({ title: 'Extract Data Error', details: 'Error extracting data from bill ' + billId + ': ' + e.toString() });
            throw e;
        }
    }

    function extractReceiptNumber(billReference) {
        var ref = billReference || '';
        var parts = ref.split('-');
        if (parts.length >= 3) return parts.slice(2).join('-');
        var match = ref.match(/IR\d+/);
        return match ? match[0] : '';
    }

    function removeDuplicateReceipts(receipts) {
        var seen = {};
        return receipts.filter(function(r){ if (seen[r.id]) return false; seen[r.id]=true; return true; });
    }

    function createConsolidatedBill(info) {
        try {
            var vendorBill = record.transform({ fromType: record.Type.PURCHASE_ORDER, fromId: info.poId, toType: record.Type.VENDOR_BILL, isDynamic: false });
            var receiptTranIds = [];
            info.receipts.forEach(function(r){
                try {
                    var rec = record.load({ type: record.Type.ITEM_RECEIPT, id: r.id, isDynamic: false });
                    receiptTranIds.push(rec.getValue({ fieldId: 'tranid' }));
                } catch (e) {
                    receiptTranIds.push('IR' + r.id);
                }
            });
            var consolidatedRef = 'CONSOLIDATED-' + info.poNumber + '-' + receiptTranIds.join('-');
            vendorBill.setValue({ fieldId: 'tranid', value: consolidatedRef });
            vendorBill.setValue({ fieldId: 'trandate', value: new Date() });
            updateConsolidatedBillLines(vendorBill, info);
            var ppvNotes = createConsolidatedPPVNotes(info, receiptTranIds);
            try {
                vendorBill.setValue({ fieldId: 'custbody_total_ppv', value: ppvNotes });
            } catch(e){ log.error({ title:'PPV Field Error', details:e.toString() }); }
            var billId = vendorBill.save();
            markReceiptsAsBilled(info.receipts, billId);
            updatePOLinesWithBillId(info.poId, billId);
            updateReceiptLinesWithBillId(info.receipts, billId);
            return billId;
        } catch (e) {
            log.error({ title: 'Create Consolidated Bill Error', details: e.toString() });
            throw e;
        }
    }

    function updateConsolidatedBillLines(vendorBill, info) {
        try {
            // remove default lines from transform
            var lineCount = vendorBill.getLineCount({ sublistId: 'item' });
            for (var r = lineCount - 1; r >= 0; r--) {
                vendorBill.removeLine({ sublistId: 'item', line: r });
            }

            for (var i = 0; i < info.lineItems.length; i++) {
                var li = info.lineItems[i];
                vendorBill.insertLine({ sublistId: 'item', line: i });
                vendorBill.setSublistValue({ sublistId: 'item', fieldId: 'item', line: i, value: li.itemId });
                vendorBill.setSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i, value: li.quantity });

                var standardCost = getLindenStandardCost(li.itemId);
                if (standardCost !== null) {
                    vendorBill.setSublistValue({ sublistId: 'item', fieldId: 'rate', line: i, value: standardCost });
                    vendorBill.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: i, value: standardCost * li.quantity });
                }

                var receiptIds = li.receipts.map(function(r){ return r.toString(); });
                vendorBill.setSublistValue({ sublistId: 'item', fieldId: 'billreceipts', line: i, value: receiptIds });
                vendorBill.setSublistValue({ sublistId: 'item', fieldId: 'custcol_cc_vb_po_link', line: i, value: info.poId });
            }
        } catch (e) {
            log.error({ title: 'Update Bill Lines Error', details: e.toString() });
            throw e;
        }
    }

    function createConsolidatedPPVNotes(info, receiptTranIds) {
        var notes = [];
        notes.push('CONSOLIDATED BILL DETAILS:');
        notes.push('Consolidated from Receipts: ' + receiptTranIds.join(', '));
        notes.push('Source PO: ' + info.poNumber);
        notes.push('Consolidation Date: ' + format.format({ value: new Date(), type: format.Type.DATE }));
        notes.push('Total Receipts: ' + info.receipts.length);
        notes.push('');
        if (info.ppvDetails.length > 0) {
            info.ppvDetails.forEach(function(ppv) {
                notes.push('=== RECEIPT: ' + ppv.receiptTranId + ' ===');
                notes.push(ppv.details);
                notes.push('');
            });
        } else {
            notes.push('No PPV details available from original bills.');
        }
        return notes.join('\n');
    }

    function markReceiptsAsBilled(receipts, billId) {
        receipts.forEach(function(r){
            try {
                record.submitFields({ type: record.Type.ITEM_RECEIPT, id: r.id, values: { 'custbody_bill_created': true } });
            } catch(e) { log.error({ title:'Receipt Update Failed', details:'Could not update receipt '+r.id+': '+e.toString() }); }
        });
    }

    function updatePOLinesWithBillId(poId, billId) {
        try {
            var purchaseOrder = record.load({ type: record.Type.PURCHASE_ORDER, id: poId, isDynamic: false });
            var lineCount = purchaseOrder.getLineCount({ sublistId: 'item' });
            for (var i = 0; i < lineCount; i++) {
                try {
                    purchaseOrder.setSublistValue({ sublistId: 'item', fieldId: 'custcol_cc_vb_po_link', line: i, value: [billId.toString()] });
                } catch(e) { log.error({ title:'PO Line Update Error', details:'Line '+i+': '+e.toString() }); }
            }
            purchaseOrder.save();
        } catch (e) { log.error({ title:'Failed to Update PO Lines', details:e.toString() }); }
    }

    function updateReceiptLinesWithBillId(receipts, billId) {
        receipts.forEach(function(r){
            try {
                var itemReceipt = record.load({ type: record.Type.ITEM_RECEIPT, id: r.id, isDynamic: false });
                var lineCount = itemReceipt.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < lineCount; i++) {
                    try {
                        itemReceipt.setSublistValue({ sublistId: 'item', fieldId: 'custcol_cc_vb_po_link', line: i, value: billId });
                    } catch(e){ log.error({ title:'Receipt Line Update Error', details:'Line '+i+': '+e.toString() }); }
                }
                itemReceipt.save();
            } catch(e){ log.error({ title:'Failed to Update Receipt Lines', details:{ receiptId: r.id, error: e.toString() }}); }
        });
    }

    function getLindenStandardCost(itemId) {
        try {
            var configSearch = search.create({
                type: 'itemlocationconfiguration',
                filters: [['item','is',itemId],'AND',['location','is',LINDEN_LOCATION_ID]],
                columns: ['defaultreturncost', 'cost']
            });
            var result = configSearch.run().getRange({ start: 0, end: 1 });
            if (result.length) {
                var cost = result[0].getValue('cost') || result[0].getValue('defaultreturncost');
                if (cost) return parseFloat(cost);
            }
            var itemRecord = record.load({ type: record.Type.INVENTORY_ITEM, id: itemId, isDynamic: false });
            var mainCost = itemRecord.getValue({ fieldId: 'cost' });
            if (mainCost) return parseFloat(mainCost);
            return null;
        } catch (e) {
            log.error({ title: 'Standard Cost Error', details: 'Error getting standard cost for item ' + itemId + ': ' + e.toString() });
            return null;
        }
    }

    return { onAction: onAction };
});
