"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create_logger = void 0;
const create_logger = (options) => ({
    info: (...messages) => {
        console.log(...messages);
    },
    error: (...messages) => {
        console.error(...messages);
    },
    main_debug: (...messages) => {
        if (options.debugMain) {
            console.log(...messages);
        }
    },
    frida_debug: (...messages) => {
        if (options.debugFrida) {
            console.log(...messages);
        }
    },
});
exports.create_logger = create_logger;
