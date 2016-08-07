/**
 * Augur JavaScript API
 * @author Jack Peterson (jack@tinybike.net)
 */

"use strict";

var clone = require("clone");
var async = require("async");
var abi = require("augur-abi");
var rpc = require("ethrpc");
var errors = require("augur-contracts").errors;
var utils = require("../utilities");
var constants = require("../constants");
var abacus = require("./abacus");

module.exports = {

    // tradeTypes: array of "buy" and/or "sell"
    // gasLimit (optional): block gas limit as integer
    isUnderGasLimit: function (tradeTypes, gasLimit, callback) {
        if (utils.is_function(gasLimit) && !callback) {
            callback = gasLimit;
            gasLimit = null;
        }
        var gas = abacus.sumTradeGas(tradeTypes);
        if (!utils.is_function(callback)) {
            if (gasLimit) return gas <= gasLimit;
            return gas <= parseInt(this.rpc.getBlock(this.rpc.blockNumber()).gasLimit, 16);
        }
        if (gasLimit) return callback(gas <= gasLimit);
        var self = this;
        this.rpc.blockNumber(function (blockNumber) {
            self.rpc.getBlock(blockNumber, false, function (block) {
                callback(gas <= parseInt(block.gasLimit, 16));
            });
        });
    },

    isTradeUnderGasLimit: function (trade_ids, callback) {
        var self = this;
        var gas = 0;
        async.forEachOfSeries(trade_ids, function (trade_id, i, next) {
            self.get_trade(trade_id, function (trade) {
                if (!trade || !trade.id) {
                    return next("couldn't find trade: " + trade_id);
                }
                gas += constants.TRADE_GAS[Number(!!i)][trade.type];
                next();
            });
        }, function (e) {
            if (e) return callback(e);
            self.rpc.blockNumber(function (blockNumber) {
                self.rpc.getBlock(blockNumber, false, function (block) {
                    callback(null, gas <= parseInt(block.gasLimit, 16));
                });
            });
        });
    },

    trade: function (max_value, max_amount, trade_ids, onTradeHash, onCommitSent, onCommitSuccess, onCommitConfirmed, onCommitFailed, onNextBlock, onTradeSent, onTradeSuccess, onTradeFailed, onTradeConfirmed) {
        var self = this;
        if (max_value.constructor === Object) {
            max_amount = max_value.max_amount;
            trade_ids = max_value.trade_ids;
            onTradeHash = max_value.onTradeHash;
            onCommitSent = max_value.onCommitSent;
            onCommitSuccess = max_value.onCommitSuccess;
            onCommitFailed = max_value.onCommitFailed;
            onCommitConfirmed = max_value.onCommitConfirmed;
            onNextBlock = max_value.onNextBlock;
            onTradeSent = max_value.onTradeSent;
            onTradeSuccess = max_value.onTradeSuccess;
            onTradeFailed = max_value.onTradeFailed;
            onTradeConfirmed = max_value.onTradeConfirmed;
            max_value = max_value.max_value;
        }
        onTradeHash = onTradeHash || utils.noop;
        onCommitSent = onCommitSent || utils.noop;
        onCommitSuccess = onCommitSuccess || utils.noop;
        onCommitFailed = onCommitFailed || utils.noop;
        onNextBlock = onNextBlock || utils.noop;
        onTradeSent = onTradeSent || utils.noop;
        onTradeSuccess = onTradeSuccess || utils.noop;
        onTradeFailed = onTradeFailed || utils.noop;
        this.isTradeUnderGasLimit(trade_ids, function (err, isUnderLimit) {
            if (err) return onCommitFailed(err);
            if (!isUnderLimit) return onCommitFailed(errors.GAS_LIMIT_EXCEEDED);
            var tradeHash = self.makeTradeHash(max_value, max_amount, trade_ids);
            onTradeHash(tradeHash);
            self.commitTrade({
                hash: tradeHash,
                onSent: onCommitSent,
                onSuccess: function (res) {
                    onCommitSuccess(res);
                    self.rpc.fastforward(1, function (blockNumber) {
                        onNextBlock(blockNumber);
                        var tx = clone(self.tx.Trade.trade);
                        tx.params = [
                            abi.fix(max_value, "hex"),
                            abi.fix(max_amount, "hex"),
                            trade_ids
                        ];
                        var prepare = function (result, cb) {
                            var txHash = result.txHash;
                            if (result.callReturn && result.callReturn.constructor === Array) {
                                result.callReturn[0] = parseInt(result.callReturn[0], 16);
                                if (result.callReturn[0] !== 1 || result.callReturn.length !== 3) {
                                    return onTradeFailed(result);
                                }
                                self.rpc.receipt(txHash, function (receipt) {
                                    if (!receipt) return onTradeFailed(errors.TRANSACTION_RECEIPT_NOT_FOUND);
                                    if (receipt.error) return onTradeFailed(receipt);
                                    var sharesBought, cashFromTrade;
                                    if (receipt && receipt.logs && receipt.logs.constructor === Array && receipt.logs.length) {
                                        var logs = receipt.logs;
                                        var sig = self.api.events.log_fill_tx.signature;
                                        sharesBought = abi.bignum(0);
                                        cashFromTrade = abi.bignum(0);
                                        for (var i = 0, numLogs = logs.length; i < numLogs; ++i) {
                                            if (logs[i].topics[0] === sig) {
                                                var logdata = self.rpc.unmarshal(logs[i].data);
                                                if (logdata && logdata.constructor === Array && logdata.length) {
                                                    // buy (matched sell order)
                                                    if (parseInt(logdata[0], 16) === 1) {
                                                        sharesBought = sharesBought.plus(abi.unfix(logdata[2]));

                                                    // sell (matched buy order)
                                                    // cash received = price per share * shares sold
                                                    } else {
                                                        cashFromTrade = cashFromTrade.plus(abi.unfix(logdata[1]).times(abi.unfix(logdata[2])));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    cb({
                                        txHash: txHash,
                                        unmatchedCash: abi.unfix(result.callReturn[1], "string"),
                                        unmatchedShares: abi.unfix(result.callReturn[2], "string"),
                                        sharesBought: abi.string(sharesBought),
                                        cashFromTrade: abi.string(cashFromTrade)
                                    });
                                });
                            } else {
                                var err = self.rpc.errorCodes("trade", "number", result.callReturn);
                                if (!err) return onTradeFailed(result);
                                onTradeFailed({error: err, message: self.errors[err], tx: tx});
                            }
                        };
                        self.transact(tx, onTradeSent, utils.compose(prepare, onTradeSuccess), onTradeFailed, utils.compose(prepare, onTradeConfirmed));
                    });
                },
                onFailed: onCommitFailed,
                onConfirmed: onCommitConfirmed
            });
        });
    },

    short_sell: function (buyer_trade_id, max_amount, onTradeHash, onCommitSent, onCommitSuccess, onCommitFailed, onCommitConfirmed, onNextBlock, onTradeSent, onTradeSuccess, onTradeFailed, onTradeConfirmed) {
        var self = this;
        if (buyer_trade_id.constructor === Object && buyer_trade_id.buyer_trade_id) {
            max_amount = buyer_trade_id.max_amount;
            onTradeHash = buyer_trade_id.onTradeHash;
            onCommitSent = buyer_trade_id.onCommitSent;
            onCommitSuccess = buyer_trade_id.onCommitSuccess;
            onCommitFailed = buyer_trade_id.onCommitFailed;
            onCommitConfirmed = buyer_trade_id.onCommitConfirmed;
            onNextBlock = buyer_trade_id.onNextBlock;
            onTradeSent = buyer_trade_id.onTradeSent;
            onTradeSuccess = buyer_trade_id.onTradeSuccess;
            onTradeFailed = buyer_trade_id.onTradeFailed;
            onTradeConfirmed = buyer_trade_id.onTradeConfirmed;
            buyer_trade_id = buyer_trade_id.buyer_trade_id;
        }
        onTradeHash = onTradeHash || utils.noop;
        onCommitSent = onCommitSent || utils.noop;
        onCommitSuccess = onCommitSuccess || utils.noop;
        onCommitFailed = onCommitFailed || utils.noop;
        onNextBlock = onNextBlock || utils.noop;
        onTradeSent = onTradeSent || utils.noop;
        onTradeSuccess = onTradeSuccess || utils.noop;
        onTradeFailed = onTradeFailed || utils.noop;
        var tradeHash = this.makeTradeHash(0, max_amount, [buyer_trade_id]);
        onTradeHash(tradeHash);
        this.commitTrade({
            hash: tradeHash,
            onSent: onCommitSent,
            onSuccess: function (res) {
                onCommitSuccess(res);
                self.rpc.fastforward(1, function (blockNumber) {
                    onNextBlock(blockNumber);
                    var tx = clone(self.tx.Trade.short_sell);
                    tx.params = [
                        buyer_trade_id,
                        abi.fix(max_amount, "hex")
                    ];
                    var prepare = function (result, cb) {
                        var txHash = result.txHash;
                        if (result.callReturn && result.callReturn.constructor === Array) {
                            result.callReturn[0] = parseInt(result.callReturn[0], 16);
                            if (result.callReturn[0] !== 1 || result.callReturn.length !== 4) {
                                return onTradeFailed(result);
                            }
                            self.rpc.receipt(txHash, function (receipt) {
                                if (!receipt) return onTradeFailed(errors.TRANSACTION_RECEIPT_NOT_FOUND);
                                if (receipt.error) return onTradeFailed(receipt);
                                var cashFromTrade;
                                if (receipt && receipt.logs && receipt.logs.constructor === Array && receipt.logs.length) {
                                    var logs = receipt.logs;
                                    var sig = self.api.events.log_fill_tx.signature;
                                    cashFromTrade = abi.bignum(0);
                                    for (var i = 0, numLogs = logs.length; i < numLogs; ++i) {
                                        if (logs[i].topics[0] === sig) {
                                            var logdata = self.rpc.unmarshal(logs[i].data);
                                            if (logdata && logdata.constructor === Array && logdata.length) {
                                                cashFromTrade = cashFromTrade.plus(abi.unfix(logdata[1]).times(abi.unfix(logdata[2])));
                                            }
                                        }
                                    }
                                }
                                cb({
                                    txHash: txHash,
                                    unmatchedShares: abi.unfix(result.callReturn[1], "string"),
                                    matchedShares: abi.unfix(result.callReturn[2], "string"),
                                    cashFromTrade: abi.string(cashFromTrade),
                                    price: abi.unfix(result.callReturn[3], "string")
                                });
                            });
                        } else {
                            var err = self.rpc.errorCodes("short_sell", "number", result.callReturn);
                            if (!err) return onTradeFailed(result);
                            onTradeFailed({error: err, message: self.errors[err], tx: tx});
                        }
                    };
                    self.transact(tx, onTradeSent, utils.compose(prepare, onTradeSuccess), onTradeFailed, utils.compose(prepare, onTradeConfirmed));
                });
            },
            onFailed: onCommitFailed,
            onConfirmed: onCommitConfirmed
        });
    }
};
