#!/usr/bin/env node

"use strict";

var assert = require("chai").assert;
var Augur = require("../augur");
var log = console.log;

Augur = require("./utilities").setup(Augur, process.argv.slice(2));

var TIMEOUT = 100000;
var branch = Augur.branches.dev;
var coinbase = Augur.coinbase;

describe("Faucets", function () {
    it("Reputation faucet", function (done) {
        this.timeout(TIMEOUT);
        Augur.reputationFaucet(
            branch,
            function (r) {
                // sent
                assert.equal(r.callReturn, "1");
                assert(parseInt(r.txHash) >= 0);
            },
            function (r) {
                // success
                assert.equal(r.callReturn, "1");
                assert(parseInt(r.blockHash) !== 0);
                assert(parseInt(r.blockNumber) >= 0);
                var rep_balance = Augur.getRepBalance(branch, coinbase);
                var cash_balance = Augur.getCashBalance(coinbase);
                assert.equal(rep_balance, "47");
                done();
            },
            function (r) {
                // failed
                throw r.message;
                done();
            }
        );
    });
    it("Cash faucet", function (done) {
        this.timeout(TIMEOUT);
        var cash_balance = Augur.getCashBalance(coinbase);
        if (Augur.bignum(cash_balance).toNumber() > 0) {
            done();
        }
        Augur.cashFaucet(
            function (r) {
                // sent
                assert(r.callReturn === "1" || r.callReturn === "-1");
                assert(parseInt(r.txHash) >= 0);
            },
            function (r) {
                // success
                assert(r.callReturn === "1" || r.callReturn === "-1");
                assert(parseInt(r.blockHash) !== 0);
                assert(parseInt(r.blockNumber) >= 0);
                var rep_balance = Augur.getRepBalance(branch, coinbase);
                var cash_balance = Augur.getCashBalance(coinbase);
                if (r.callReturn === "1") {
                    assert.equal(cash_balance, "10000");
                } else {
                    assert(Augur.bignum(cash_balance).toNumber() > 5);
                }
                done();
            },
            function (r) {
                // failed
                throw r.message;
                done();
            }
        );
    });
});
