var hash = require("../../utils/hash");
var FeaturesUnit = require("../../features");
var sprintf = require("sprintf").sprintf;
var _ = require("underscore")._;

/**
 * BinarySegmentation - Multi-label text classifier, based on a segmentation scheme using base binary classifiers.
 *
 * Inspired by:
 *
 * Morbini Fabrizio, Sagae Kenji. Joint Identification and Segmentation of Domain-Specific Dialogue Acts for Conversational Dialogue Systems. ACL-HLT 2011
 * http://www.citeulike.org/user/erelsegal-halevi/article/10259046
 *
 * @author Erel Segal-haLevi
 * 
 * @param opts
 *            binaryClassifierType (mandatory) - the type of the base binary classifier. 
 *            binaryClassifierOptions (optional) - options that will be sent to the binary classifier constructor.
 *            featureExtractor (optional) - a single feature-extractor (see the "features" folder), or an array of extractors, for extracting features from the text segments during classification.
 */
var BinarySegmentation = function(opts) {
	if (!('binaryClassifierType' in opts)) {
		console.dir(opts);
		throw new Error("opts must contain binaryClassifierType");
	}
	if (!opts.binaryClassifierType) {
		console.dir(opts);
		throw new Error("opts.binaryClassifierType is null");
	}
	this.binaryClassifierType = opts.binaryClassifierType;
	this.binaryClassifierOptions = opts.binaryClassifierOptions;
	this.featureExtractor = FeaturesUnit.normalize(opts.featureExtractor);
	
	switch (opts.segmentSplitStrategy) {
	case 'shortestSegment': this.segmentSplitStrategy = this.shortestSegmentSplitStrategy; break;
	case 'longestSegment':  this.segmentSplitStrategy = this.longestSegmentSplitStrategy;  break;
	default: this.segmentSplitStrategy = null;
	}
	
	this.mapClassnameToClassifier = {};
}

BinarySegmentation.prototype = {

	/**
	 * Tell the classifier that the given classes will be used for the following
	 * samples, so that it will know to add negative samples to classes that do
	 * not appear.
	 * 
	 * @param classes
	 *            an object whose KEYS are classes, or an array whose VALUES are
	 *            classes.
	 */
	addClasses: function(classes) {
		classes = hash.normalized(classes);
		for ( var aClass in classes) {
			if (!this.mapClassnameToClassifier[aClass]) {
				this.mapClassnameToClassifier[aClass] = new this.binaryClassifierType(
					this.binaryClassifierOptions);
			}
		}
	},
	
	getAllClasses: function() {
		return Object.keys(this.mapClassnameToClassifier);
	},

	/**
	 * Tell the classifier that the given sample belongs to the given classes.
	 * 
	 * @param sample
	 *            a document.
	 * @param classes
	 *            an object whose KEYS are classes, or an array whose VALUES are classes.
	 */
	trainOnline: function(sample, classes) {
		sample = this.sampleToFeatures(sample, this.featureExtractor);
		classes = hash.normalized(classes);
		for (var positiveClass in classes) {
			this.makeSureClassifierExists(positiveClass);
			this.mapClassnameToClassifier[positiveClass].trainOnline(sample, 1);
		}
		for (var negativeClass in this.mapClassnameToClassifier) {
			if (!classes[negativeClass])
				this.mapClassnameToClassifier[negativeClass].trainOnline(sample, 0);
		}
	},

	/**
	 * Train the classifier with all the given documents.
	 * 
	 * @param dataset
	 *            an array with objects of the format: 
	 *            {input: sample1, output: [class11, class12...]}
	 */
	trainBatch : function(dataset) {
		// this variable will hold a dataset for each binary classifier:
		var mapClassnameToDataset = {}; 

		// create positive samples for each class:
		for ( var i = 0; i < dataset.length; ++i) {
			dataset[i].features = this.sampleToFeatures(dataset[i].input, this.featureExtractor);
			dataset[i].output = hash.normalized(dataset[i].output);

			var sample = dataset[i].features;
			var classes = dataset[i].output;
			for (var positiveClass in classes) {  // the current sample is a positive example for each of the classes in its set
				this.makeSureClassifierExists(positiveClass);
				if (!(positiveClass in mapClassnameToDataset)) // make sure dataset for this class exists
					mapClassnameToDataset[positiveClass] = [];
				mapClassnameToDataset[positiveClass].push({
					input : sample,
					output : 1
				});
			}
		}

		// create negative samples for each class (after all classes are in the array):
		for ( var i = 0; i < dataset.length; ++i) {
			var sample = dataset[i].features;
			var classes = dataset[i].output;
			for (var negativeClass in this.mapClassnameToClassifier) { // the current sample is a negative example for each of the classes NOT in its set
				if (!(negativeClass in mapClassnameToDataset)) // make sure dataset for this class exists
					mapClassnameToDataset[negativeClass] = [];
				if (!classes[negativeClass])
					mapClassnameToDataset[negativeClass].push({
						input : sample,
						output : 0
					})
			}
		}

		// train all classifiers:
		for (var aClass in mapClassnameToDataset) {
			this.mapClassnameToClassifier[aClass]
					.trainBatch(mapClassnameToDataset[aClass]);
		}
	},

	/**
	 * Internal function - use the model trained so far to classify a single segment of a sentence.
	 * 
	 * @param sample a part of a text sentence.
	 * @param explain - int - if positive, an "explanation" field, with the given length, will be added to the result.
	 *  
	 * @return an array whose VALUES are classes.
	 */
	classifySegment: function(segment, explain) {
		var classes = {};
		sample = this.sampleToFeatures(segment, this.featureExtractor);
		if (explain>0) var positive_explanations = {}, negative_explanations = {};
		for (var aClass in this.mapClassnameToClassifier) {
			var classifier = this.mapClassnameToClassifier[aClass];
			var classification = classifier.classify(sample, explain);
			if (classification.explanation) {
				var explanations_string = classification.explanation.reduce(function(a,b) {
					return a + " " + sprintf("%s%+1.2f",b.feature,b.relevance);
				}, "");
				if (classification.classification > 0.5) {
					classes[aClass] = true;
					if (explain>0) positive_explanations[aClass]=explanations_string;
				} else {
					if (explain>0) negative_explanations[aClass]=explanations_string;
				}
			} else {
				if (classification > 0.5)
					classes[aClass] = true;
			}
		}
		classes = Object.keys(classes);
		return (explain>0?
			{
				classes: classes, 
				explanation: {
					positive: positive_explanations,
					negative: negative_explanations
				}
			}:
			classes);
	},
	
	
	/**
	 * protected function:
	 * Strategy of classifying the shortest segments with a single class.
	 */
	shortestSegmentSplitStrategy: function(words, accumulatedClasses, explain, explanations) {
		var currentStart = 0;
		for (var currentEnd=1; currentEnd<=words.length; ++currentEnd) {
			var segment = words.slice(currentStart,currentEnd).join(" ");
			var segmentClassesWithExplain = this.classifySegment(segment, explain);
			var segmentClasses = (segmentClassesWithExplain.classes? segmentClassesWithExplain.classes: segmentClassesWithExplain);

			if (segmentClasses.length==1) {
				// greedy algorithm: found a section with a single class - cut it and go on
				accumulatedClasses[segmentClasses[0]]=true;
				currentStart = currentEnd;
				if (explain>0) {
					explanations.push(segment);
					explanations.push(segmentClassesWithExplain.explanation);
				};
			}
		}
	},

	
	/**
	 * protected function:
	 * Strategy of classifying the longest segments with a single class.
	 */
	longestSegmentSplitStrategy: function(words, accumulatedClasses, explain, explanations) {
		var currentStart = 0;
		var segment = null;
		var segmentClassesWithExplain = null;
		var segmentClasses = null;
		for (var currentEnd=1; currentEnd<=words.length; ++currentEnd) {
			var nextSegment = words.slice(currentStart,currentEnd).join(" ");
			var nextSegmentClassesWithExplain = this.classifySegment(nextSegment, explain);
			var nextSegmentClasses = (nextSegmentClassesWithExplain.classes? nextSegmentClassesWithExplain.classes: nextSegmentClassesWithExplain);
			//console.log("\t"+JSON.stringify(nextSegment) +" -> "+nextSegmentClasses)
			nextSegmentClasses.sort();

			if (segmentClasses && segmentClasses.length==1 && (nextSegmentClasses.length>1 || !_(nextSegmentClasses).isEqual(segmentClasses))) {
				// greedy algorithm: found a section with a single class - cut it and go on
				accumulatedClasses[segmentClasses[0]]=true;
				currentStart = currentEnd-1;
				if (explain>0) {
					explanations.push(segment);
					explanations.push(segmentClassesWithExplain.explanation);
				};
			}

			segment = nextSegment;
			segmentClassesWithExplain = nextSegmentClassesWithExplain;
			segmentClasses = nextSegmentClasses;
		}
		
		// add the classes of the last section:
		for (var i in segmentClasses) 
			accumulatedClasses[segmentClasses[i]]=true;
		if (explain>0) {
			explanations.push(segment);
			explanations.push(segmentClassesWithExplain.explanation);
		};
		/*if (words.length>20)  {
			console.dir(explanations);
			process.exit(1);
		}*/
	},

	/**
	 * Use the model trained so far to classify a new sample.
	 * 
	 * @param segment a part of a text sentence.
	 * @param explain - int - if positive, an "explanation" field, with the given length, will be added to the result.
	 *  
	 * @return an array whose VALUES are classes.
	 */
	classify: function(sentence, explain) {
		if (this.segmentSplitStrategy) {
			var words = sentence.split(/ /);
			var accumulatedClasses = {};
			var explanations = [];
			this.segmentSplitStrategy(words, accumulatedClasses, explain, explanations); 
			// this is either this.shortestSegmentSplitStrategy, or this.longestSegmentSplitStrategy
			
			var classes = Object.keys(accumulatedClasses);
			return (explain>0?	{
				classes: classes, 
				explanation: explanations
			}: 
			classes);
		} else {
			return this.classifySegment(sentence, explain);
		}
	},

	toJSON : function(callback) {
		var result = {};
		for ( var aClass in this.mapClassnameToClassifier) {
			var binaryClassifier = this.mapClassnameToClassifier[aClass];
			if (!binaryClassifier.toJSON) {
				console.dir(binaryClassifier);
				console.log("prototype: ");
				console.dir(binaryClassifier.__proto__);
				throw new Error("this binary classifier does not have a toJSON function");
			}
			result[aClass] = binaryClassifier.toJSON(callback);
		}
		return result;
	},

	fromJSON : function(json, callback) {
		for ( var aClass in json) {
			this.mapClassnameToClassifier[aClass] = new this.binaryClassifierType(
					this.binaryClassifierOptions);
			this.mapClassnameToClassifier[aClass].fromJSON(json[aClass]);
		}
		return this;
	},
	
	// private function: 
	makeSureClassifierExists: function(aClass) {
		if (!this.mapClassnameToClassifier[aClass]) { // make sure classifier exists
			this.mapClassnameToClassifier[aClass] = new this.binaryClassifierType(
					this.binaryClassifierOptions);
		}
	},
	
	// private function: 
	sampleToFeatures: function(sample, featureExtractor) {
		var features = sample;
		if (featureExtractor) {
			try {
				features = featureExtractor(sample);
			} catch (err) {
				throw new Error("Cannot extract features from '"+JSON.stringify(sample)+"': "+JSON.stringify(err));
			}
		}
		return features;
	},
}

module.exports = BinarySegmentation;