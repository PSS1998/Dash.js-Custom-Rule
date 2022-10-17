/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

var BitrateRule;

function BitrateRuleClass() {

    let context = this.context;
    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let MetricsModel = factory.getSingletonFactoryByName('MetricsModel')(context).getInstance();
    let DashMetrics = factory.getSingletonFactoryByName('DashMetrics');
    let StreamController = factory.getSingletonFactoryByName('StreamController');
    let instance;
    let INSUFFICIENT_BUFFER_SAFETY_FACTOR = 0.5;
    let react = 0;
    let startupDelay = 3;
    let lowBufferDelay = 3;
    let lastBufferLevel = 0;
    let bufferLevelHistory = [];

    // Gets called when the rule is created
    function setup() {
        console.log('Rule Created');
    }


    // This function gets called every time a segment is downloaded. Design your bitrate algorithm around that principle.
    function getMaxIndex(rulesContext) {
        var mediaType = rulesContext.getMediaType();
        var metrics = MetricsModel.getMetricsFor(mediaType, true);
        let dashMetrics = DashMetrics(context).getInstance();

        let requests = dashMetrics.getHttpRequests(mediaType);

        let streamInfo = rulesContext.getStreamInfo();
        let isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        let representationInfo = rulesContext.getRepresentationInfo();
        let fragmentDuration = representationInfo.fragmentDuration;

        // A smart bitrate rule could analyze playback metrics to take the
        // bitrate switching decision. Printing metrics here as a reference.
        // Go through them to see what you have available.
        // console.log(metrics);
        
        let bufferLevel = 0;
        if (metrics['BufferLevel'].length > 0) {
            bufferLevel = metrics['BufferLevel'][metrics['BufferLevel'].length-1]['level'];
        }
        if (lastBufferLevel == 0){
            lastBufferLevel = bufferLevel;
            bufferLevelHistory.push(bufferLevel);
            if (bufferLevelHistory.length > 5) {
                bufferLevelHistory = bufferLevelHistory.slice(bufferLevelHistory.length-5, bufferLevelHistory.length)
            }
        }

        let quality = 0;
        let switchReason = "";
    
        // Get current bitrate
        let streamController = StreamController(context).getInstance();
        let abrController = rulesContext.getAbrController();
        let current = abrController.getQualityFor(mediaType, streamController.getActiveStreamInfo().id);
        let throughputHistory = abrController.getThroughputHistory();
        let throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        let latency = throughputHistory.getAverageLatency(mediaType);
        let bitrate = throughput * (bufferLevel / fragmentDuration) * INSUFFICIENT_BUFFER_SAFETY_FACTOR;

        let lowBufferQuality = getProperQualityIndex(bitrate, rulesContext.getMediaInfo()['bitrateList'], bufferLevel);
        quality = getProperQualityIndex(throughput, rulesContext.getMediaInfo()['bitrateList'], bufferLevel);
        quality = Math.min(quality, lowBufferQuality)
        switchReason = "Proper BitRate";

        if (lastBufferLevel - bufferLevel > 600) {
            quality = 0;
            react = 2;
            switchReason = "Buffer Drop";
        }
        if (bufferLevelHistory[bufferLevelHistory.length-3] - bufferLevel > 1800) {
            quality = 0;
            react = 2;
            switchReason = "Buffer Drop";
        }

        currentRequest = requests[requests.length-1];
        if (currentRequest) {
            let totalTime = (currentRequest._tfinish.getTime() - currentRequest.trequest.getTime()) / 1000;
            let downloadTime = (currentRequest._tfinish.getTime() - currentRequest.tresponse.getTime()) / 1000;
            let totalBytesLength = getBytesLength(currentRequest);
            totalBytesLength *= 8;
            calculatedBandwidth = totalBytesLength / downloadTime;

            if ((calculatedBandwidth*1024)*0.9 < rulesContext.getMediaInfo()['bitrateList'][0].bandwidth) {
                quality = 0;
                react = 2;
            }
        }

        lastBufferLevel = bufferLevel;
        
        // If quality matches current bitrate, don't do anything
        if (current == quality) {
            react = 0;
            console.log('Do nothing!');
            return SwitchRequest(context).create();
        }
        else{
            if (react < 2) {
                if (current - quality < 2 || quality - current < 2) {
                    react += 2
                }
                else{
                    react += 1;
                }
                console.log('Do nothing!');
                return SwitchRequest(context).create();
            }
            else{
                // Send quality switch request
                react = 0;
                console.log("Switching quality");
                let switchRequest = SwitchRequest(context).create();
                switchRequest.quality = quality;
                switchRequest.reason = switchReason;
                switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
                return switchRequest;
            }
        }
    
    }

    function getProperQualityIndex(currentThroughput, bitRateList, bufferLevel) {
        let index = 0;
        bitRateList.forEach((element, i) => {
            if ((currentThroughput*1024)*0.9 > element.bandwidth){
                index = i;
            }
        });

        if (bufferLevel > 9000) {
            index += 1;
            react = 2;
        }
        if (bufferLevel > 9250) {
            index += 1;
            react = 2;
        }

        if ((currentThroughput*1024) < bitRateList[0].bandwidth) {
            index = 0;
            react = 2;
        }

        if (bufferLevel < 2500) {
            index = 0;
            lowBufferDelay = 3;
        }
        else{
            if (lowBufferDelay != 0) {
                index = 0;
                lowBufferDelay = lowBufferDelay - 1
            }
        }

        if (isNaN(currentThroughput)) {
            index = 0;
            startupDelay = 5;
        }
        else{
            if (startupDelay != 0) {
                index = 0;
                startupDelay = startupDelay - 1
            }
        }

        return index;
    }

    function getBytesLength(request) {
        return request.trace.reduce(function (a, b) {
            return a + b.b[0];
        }, 0);
    }

    instance = {
        getMaxIndex: getMaxIndex
    };

    setup();

    return instance;
}

BitrateRuleClass.__dashjs_factory_name = 'BitrateRule';
BitrateRule = dashjs.FactoryMaker.getClassFactory(BitrateRuleClass);

