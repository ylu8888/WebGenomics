/**
 * 1) Call fetchWrapper
 * 2) It will then look into the interface member
 * 3) Process a diff between what exists in the interface already and what needs to be fetched
 * 4) Constructs a series of new queries which will use Jakub's fetch to then obtain the data
 * 5) Combines the queries results and existing data in our database (interface) into one and returns 1-D array
 */

/**
 * Improvements:
 * Abstraction: Data acquisition, interface for type of 'data' storable
 * Web workers
 */

// Test commands:
// initDatabase()
// cacheMe = new CacheInterface()
// cacheMe.fetchWrapper(['ACC'], ['ABI1'], ['TCGA-OR-A5J1','TCGA-OR-A5J2','TCGA-OR-A5J3'])
// cacheMe.fetchWrapper(['ACC'], ['ABI1'], ['TCGA-OR-A5J1','TCGA-OR-A5J2','TCGA-OR-A5J3', 'TCGA-OR-A5JO'])

// Note: You may create multiple new loki() objects, if they share the same name, they are essentially the same.
// You must also call db.loadDatabase(...) to populate the loki object with data from IndexedDB.
// Data existing in IndexedDB != present in loki(), remember loki() is "middle-man".

// Bugs(?):
// The data might sometimes not get saved

var cacheMe = undefined

async function getCacheMe() {
    if (cacheMe) {
        return cacheMe
    } else {
        return new Promise((resolve, reject) => {
            const db = new loki('smart-cache.db', {
                adapter: new LokiIndexedAdapter(),
            })
            db.loadDatabase({}, (err) => {
                if (err) reject(err)
                if (!db.getCollection('cohorts')) {
                    console.warn('db re-initialized')
                    db.addCollection('cohorts', { unique: '_id' })
                    db.saveDatabase()
                }
                cacheMe = new CacheInterface()
                resolve(cacheMe)
            })
        })
    }
}

function CacheInterface() {
    this.interface = new Map([])
    this.db = new loki('smart-cache.db', {
        adapter: new LokiIndexedAdapter(),
    })
    this.db.loadDatabase({}, () => {
        let dv = this.db.getCollection('cohorts').addDynamicView('dv')
        let results = dv.data()
        for (let r of results) {
            this.interface.set(r._id, new Map([]))
            let cohortData = this.db.getCollection(r._id).data
            for (let gene of cohortData) {
                this.interface.get(r._id).set(gene._id, new Map(Object.entries(gene.barcodes)))
            }
        }
    })

    this.saveToDB = function (cohort, barcode, expression, payload) {
        let dv = this.db.getCollection('cohorts').addDynamicView('dv')
            .applyFind({ _id: cohort }) // Check if _cohort exists
        if (dv.data().length <= 0) { // Not found, create the collection named _cohort
            this.db.getCollection('cohorts').insert({ '_id': cohort })
            let newCohortCollection = this.db.addCollection(cohort, { unique: '_id', ttl: 604800000 })
            newCohortCollection.insert({
                '_id': expression,
                barcodes: {
                    [barcode]: payload
                }
            })
        } else { // _cohort collection exists
            let foundCohortCollection = this.db.getCollection(cohort)
            let existingExpr = foundCohortCollection.by('_id', expression)
            if (existingExpr) {
                existingExpr.barcodes = {
                    ...existingExpr.barcodes,
                    [barcode]: payload
                }
                foundCohortCollection.update(existingExpr)
            } else {
                foundCohortCollection.insert({
                    '_id': expression,
                    barcodes: {
                        [barcode]: payload
                    }
                })
            }
        }
        // this.db.saveDatabase()
    }

    this.getFromDB = function (cohort, barcode, expression) {
        this.db.getCollection(cohort).data.map((expr) => Object.values(expr.barcodes))
    }

    this.add = function (cohort, barcode, expression, payload) {
        let interface = this.interface
        if (!interface.get(cohort)) {
            interface.set(cohort, new Map([]))
        }

        if (interface.get(cohort).get(expression)) {
            let temp = interface.get(cohort).get(expression).get(barcode)
            if (typeof temp === 'undefined') {
                interface.get(cohort).get(expression).set(barcode, payload)
            }
        } else {
            interface.get(cohort).set(expression, new Map([
                [barcode, payload]
            ]))
        }
    }

    this.findDiff = function (listOfBarcodes, cohort, expression) {
        let s = new Set()
        let foundS = new Set()
        let interface = this.interface
        if (interface.has(cohort) && interface.get(cohort).has(expression)) {
            let map = interface.get(cohort).get(expression)
            for (let barcode of listOfBarcodes) {
                if (!map.has(barcode)) {
                    s.add(barcode)
                } else {
                    foundS.add(barcode)
                }
            }
        } else {
            return [new Set(listOfBarcodes), foundS]
        }
        return [s, foundS]
    }

    this.constructQueries = function (listOfCohorts, listOfExpressions, listOfBarcodes) {
        let res = {}
        let foundRes = {}
        for (let cohort of listOfCohorts) {
            if (!(cohort in res)) {
                res[cohort] = {}
            }
            if (!(cohort in foundRes)) {
                foundRes[cohort] = {}
            }
            for (let expr of listOfExpressions) {
                if (!(expr in res[cohort])) {
                    res[cohort][expr] = []
                }
                if (!(expr in foundRes[cohort])) {
                    foundRes[cohort][expr] = []
                }
                let [diff, alreadyHave] = this.findDiff(listOfBarcodes, cohort, expr)
                if (diff.size > 0) {
                    diff.forEach(val => res[cohort][expr].push(val))
                }
                if (alreadyHave.size > 0) {
                    alreadyHave.forEach(val => foundRes[cohort][expr].push(val))
                }
            }
        }
        for (let k in foundRes) {
            for (let k2 in foundRes[k]) {
                if (foundRes[k][k2].length === 0) {
                    delete foundRes[k][k2]
                }
            }
        }
        return [res, foundRes]
    }

    this.executeQueries = function (interface) {
        let promises = []
        for (let cohort in interface) {
            for (let expr in interface[cohort]) {
                promises.push(
                    firebrowse.fetchmRNASeq({ cohorts: [cohort], genes: [expr], barcodes: interface[cohort][expr] })
                        .then(res => {
                            console.log(res)
                            return res.map(obj => {
                                // Store the entire obj into the interface
                                this.add(obj.cohort, obj.tcga_participant_barcode, expr, obj)
                                this.saveToDB(obj.cohort, obj.tcga_participant_barcode, expr, obj)
                                return obj
                            })
                        })
                        .catch(error => {
                            console.error("Failed, skipping.", error)
                            return undefined
                        })
                )
            }
        }
        return promises
    }

    this.fetchWrapper = async function (listOfCohorts, listOfExpressions, listOfBarcodes) {
        let [missingInterface, hasInterface] = this.constructQueries(listOfCohorts, listOfExpressions, listOfBarcodes)
        let promises = this.executeQueries(missingInterface)
        // console.log(hasInterface)
        // RETURNS A 2-D ARRAY of size COHORT.len * GENE.len, each index contains an array for that combo
        return (await Promise.all(promises)
            .then(allData => {
                this.db.saveDatabase((err) => {
                    if (err) {
                        console.error(err)
                    } else {
                        console.log('Saved.')
                    }
                })
                let tmp = []
                // OPT 1: Fetches from DB.
                // for (let cohort in hasInterface) {
                //     let foundCohortCollection = this.db.getCollection(cohort)
                //     let dynamicView = foundCohortCollection.addDynamicView('findExistingGenes')
                //     let existingGenes = Object.keys(hasInterface[cohort])
                //     // doc._id is the GENE_EXPR
                //     dynamicView.applyWhere(function (doc) { return existingGenes.includes(doc._id) })
                //     // REAL data is dv.data().map(data => data.barcodes)
                //     tmp.push(dynamicView.data().map(data => Object.values(data.barcodes)))
                // }
                // OPT 2: Fetches from interface.
                for (let cohort in hasInterface) {
                    let interfaceData = this.interface.get(cohort) // Map([])
                    for (let gene of Object.keys(hasInterface[cohort])) {
                        hasListOfBarcodes = hasInterface[cohort][gene]
                        for (let barCode of hasListOfBarcodes) {
                            tmp.push(interfaceData.get(gene).get(barCode))
                        }
                    }
                }
                return allData.filter(lst => lst.length !== 0).concat(...tmp)
            })).flat()
    }
}

CacheInterface.prototype.pprint = function () {
    function f(entries) {
        let o = Object.fromEntries(entries)
        for (let [key, val] of Object.entries(o)) {
            if (val instanceof Map) {
                o[key] = f(val)
            }
        }
        return o
    }
    return f(this.interface)
}
