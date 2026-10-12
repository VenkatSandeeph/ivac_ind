"use strict";
$(document).ready(function () {
    if (navigator.userAgent.match(/IEMobile\/10\.0/)) {
        var t = document.createElement("style");
        t.appendChild(document.createTextNode("@-ms-viewport{width:auto!important}")),
        t.appendChild(document.createTextNode("@-ms-viewport{height:auto!important}")),
        document.getElementsByTagName("head")[0].appendChild(t)
    }
    if (navigator.userAgent.match(/MSIE 10/i)) {
        var e = $("#footer_links_container");
        $(e).css("padding-top", "100px")
    }
    var o,
    i = $("#background_background_image"),
    n = function () {
        document.body.style.overflow = "hidden",
        ($(window).width() - 500) / $(window).height() < o ? (i.height($(window).height()), i.width("auto")) : (i.width($(window).width() - 500), i.height("auto")),
        document.body.style.overflow = ""
    };
    $("<img>").attr("src", i.attr("src")).on("load", function () {
        o = this.width / this.height,
        n()
    }),
    $(window).resize(function () {
        n()
    }),
    "undefined" != typeof $("#MicrosoftAccountExchange") && $("#MicrosoftAccountExchange").text("Microsoft"),
    $("*").removeAttr("placeholder")

    let locale_value = '';
    if(location.search) {
        let params = location.search.substring(1);
        let queryString = new URLSearchParams(params);
        for(let pair of queryString.entries()) {
            if (pair[0] == 'ui_locales') {
                locale_value = pair[1];
                break;
            }
        }
    }

    console.log("Navigator Language from Browser:", navigator.language || navigator.userLanguage);
    console.log("Locale Value from URL is: " + locale_value);
    let language = navigator.language || navigator.userLanguage;
    if (locale_value == 'en-US' || (locale_value == '' && language.startsWith('en'))) {
        $("#captcha-content-en").show();
    } else if (locale_value == 'ja-JP' || (locale_value == '' && language.startsWith('ja'))) {
        $("#captcha-content-ja").show();
    } else if (locale_value == 'ko-KR' || (locale_value == '' && language.startsWith('ko'))) {
        $("#captcha-content-ko").show();
    } else if (locale_value == 'id-ID' || (locale_value == '' && language.startsWith('id'))) {
        $("#captcha-content-id").show();
    } else if (locale_value == 'ms-MY' || (locale_value == '' && language.startsWith('ms'))) {
        $("#captcha-content-ms").show();
    } else if (locale_value == 'zh-TW') {
        $("#captcha-content-zh-TW").show();
    }  else if (locale_value == 'zh-CN') {
        $("#captcha-content-zh-CN").show();
    } else if (locale_value == 'th-TH' || (locale_value == '' && language.startsWith('th'))) {
        $("#captcha-content-th").show();
    } else if (locale_value == 'vi-VN' || (locale_value == '' && language.startsWith('vi'))) {
        $("#captcha-content-vi").show();
    } else if (locale_value == 'eu-ES' || locale_value == 'fil-PH' || (locale_value == '' && language.startsWith('fil'))) {
        $("#captcha-content-fil").show();
    } else if (locale_value == 'gl-ES' || locale_value == 'lo-LA' || (locale_value == '' && language.startsWith('lo'))) {
        $("#captcha-content-lo").show();
    } else if (locale_value == 'nl-NL' || locale_value == 'km-KH' || (locale_value == '' && language.startsWith('km'))) {
        $("#captcha-content-km").show();
    } else if (locale_value == 'ca-ES' || (locale_value == '' && language.startsWith('ca'))) {
        $("#captcha-content-ca").show();
    } else if (locale_value == 'ar-SA' || (locale_value == '' && language.startsWith('ar'))) {
        $("#captcha-content-ar").show();
    } else if (locale_value == 'cs-CZ' || (locale_value == '' && language.startsWith('cs'))) {
        $("#captcha-content-cs").show();
    } else if (locale_value == 'da-DK' || (locale_value == '' && language.startsWith('da'))) {
        $("#captcha-content-da").show();
    } else if (locale_value == 'et-EE' || (locale_value == '' && language.startsWith('et'))) {
        $("#captcha-content-et").show();
    } else if (locale_value == 'fi-FI' || (locale_value == '' && language.startsWith('fi'))) {
        $("#captcha-content-fi").show();
    } else if (locale_value == 'fr-FR' || (locale_value == '' && language.startsWith('fr'))) {
        $("#captcha-content-fr").show();
    } else if (locale_value == 'de-DE' || (locale_value == '' && language.startsWith('de'))) {
        $("#captcha-content-de").show();
    } else if (locale_value == 'he-IL' || (locale_value == '' && language.startsWith('he'))) {
        $("#captcha-content-he").show();
    } else if (locale_value == 'hu-HU' || (locale_value == '' && language.startsWith('hu'))) {
        $("#captcha-content-hu").show();
    } else if (locale_value == 'lv-LV' || (locale_value == '' && language.startsWith('lv'))) {
        $("#captcha-content-lv").show();
    } else if (locale_value == 'pt-BR') {
        $("#captcha-content-pt-BR").show();
    } else if (locale_value == 'nb-NO' || (locale_value == '' && language.startsWith('nb'))) {
        $("#captcha-content-nb").show();
    } else if (locale_value == 'sk-SK' || (locale_value == '' && language.startsWith('sk'))) {
        $("#captcha-content-sk").show();
    } else if (locale_value == 'sv-SE' || (locale_value == '' && language.startsWith('sv'))) {
        $("#captcha-content-sv").show();
    } else if (locale_value == 'zh-HK') {
        $("#captcha-content-zh-HK").show();
    } else if (locale_value == 'kk-KZ' || locale_value == 'mn-Mong-CN') {
        $("#captcha-content-mn-Mong-CN").show();
    } else if (locale_value == 'it-IT') {
        $("#captcha-content-it-IT").show();
    } else if (locale_value == 'pt-PT') {
        $("#captcha-content-pt-PT").show();
    } else if (locale_value == 'sr-Cyrl-CS') {
        $("#captcha-content-sr-Cyrl-CS").show();
    } else if (locale_value == 'sl-SI') {
        $("#captcha-content-sl-SI").show();
    } else if (locale_value == 'hi-IN') {
        $("#captcha-content-hi-IN").show();
    } else if (locale_value == 'ru-RU') {
        $("#captcha-content-ru-RU").show();
    } else if (locale_value == 'bg-BG') {
        $("#captcha-content-bg-BG").show();
    } else if (locale_value == 'hr-HR') {
        $("#captcha-content-hr-HR").show();
    } else if (locale_value == 'sq-AL') {
        $("#captcha-content-sq-AL").show();
    } else if (locale_value == 'hy-AM') {
        $("#captcha-content-hy-AM").show();
    } else if (locale_value == 'az-Cyrl-AZ') {
        $("#captcha-content-az-Cyrl-AZ").show();
    } else if (locale_value == 'bs-Latn-BA') {
        $("#captcha-content-bs-Latn-BA").show();
    } else if (locale_value == 'fa-IR') {
        $("#captcha-content-fa-IR").show();
    } else if (locale_value == 'ka-GE') {
        $("#captcha-content-ka-GE").show();
    } else if (locale_value == 'mk-MK') {
        $("#captcha-content-mk-MK").show();
    } else if (locale_value == 'el-GR') {
        $("#captcha-content-el-GR").show();
    } else if (locale_value == 'lt-LT') {
        $("#captcha-content-lt-LT").show();
    } else if (locale_value == 'pl-PL') {
        $("#captcha-content-pl-PL").show();
    } else if (locale_value == 'ro-RO') {
        $("#captcha-content-ro-RO").show();
    } else if (locale_value == 'sr-Latn-CS') {
        $("#captcha-content-sr-Latn-CS").show();
    } else if (locale_value == 'tr-TR') {
        $("#captcha-content-tr-TR").show();
    } else if (locale_value == 'uk-UA') {
        $("#captcha-content-uk-UA").show();
    } else {
        $("#captcha-content-en").show();
    }
});
