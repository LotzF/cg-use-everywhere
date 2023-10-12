import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";
import { UseEverywhereList } from "./use_everywhere_classes.js";
import { add_ue_from_node } from "./use_everywhere_nodes.js";
import { node_in_loop, node_is_live, is_connected, is_UEnode, inject, Logger } from "./use_everywhere_utilities.js";
import { displayMessage, update_input_label, indicate_group_restriction } from "./use_everywhere_ui.js";
import { LinkRenderController } from "./use_everywhere_ui.js";


var _original_graphToPrompt; // gets populated with the original method in setup()
/*
Get the graph and analyse it.
If modify_and_return_prompt is true, apply UE modifications and return the prompt (for hijack)
If modify_and_return_prompt is false, jsut return the UseEverywhereList (for UI highlights etc) 
*/
async function analyse_graph(modify_and_return_prompt=false) {
    var p = await _original_graphToPrompt.apply(app);
    if (modify_and_return_prompt) {
        p = structuredClone(p);
    } 
            
    // Create a UseEverywhereList and populate it from all live (not bypassed) nodes
    const ues = new UseEverywhereList();
    const live_nodes = p.workflow.nodes.filter((node) => node_is_live(node))
    live_nodes.filter((node) => is_UEnode(node)).forEach(node => { add_ue_from_node(ues, node); })

    const links_added = new Set();
    // Look for unconnected inputs and see if we can connect them
    live_nodes.filter((node) => !is_UEnode(node)).forEach(node => {
        node.inputs?.forEach(input => {
            if (!is_connected(input)) {
                var ue = ues.find_best_match(node, input);
                if (ue && modify_and_return_prompt) {
                    p.output[node.id].inputs[input.name] = ue.output;
                    links_added.add({"downstream":node.id, "upstream":ue.output[0], "controller":ue.controller.id});
                }
            }
        });
    });

    // if there are loops report them and raise an exception
    if (app.ui.settings.getSettingValue('AE.checkloops', true)) {
        try {
            node_in_loop(live_nodes, links_added);
        } catch (e) {
            if (!e.stack) throw e;
            if (e.ues && e.ues.length > 0){
                alert(`Loop (${e.stack}) with broadcast (${e.ues}) - not submitting workflow`);
            } else {
                alert(`Loop (${e.stack}) - not submitting workflow`);
            }
            throw new Error(`Loop Detected ${e.stack}, ${e.ues}`, {"cause":e});
        }
    }

    if (modify_and_return_prompt) return p;
    else return ues;
}

/*
The ui component that looks after the link rendering
*/
const _lrc = new LinkRenderController(analyse_graph);

/*
Inject a call to _lrc.mark_list_link_outdated into a method with name methodname on all objects in the array
If object is undefined, do nothing.
The injection is added at the end of the existing method (if the method didn't exist, it is created).
A Logger.trace call is added at the start with 'tracetext'
*/
function inject_outdating_into_objects(array, methodname, tracetext) {
    if (array) {
        array.forEach((object) => { inject_outdating_into_object_method(object, methodname, tracetext); })
    }
}
function inject_outdating_into_object_method(object, methodname, tracetext) {
    if (object) inject(object, methodname, tracetext, _lrc.mark_link_list_outdated, _lrc);
}

app.registerExtension({
	name: "cg.customnodes.use_everywhere",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        /*
        When a node is connected or unconnected, the link list is dirty.
        If it is a UE node, we need to update it as well
        */
        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (side,slot,connect,link_info,output) {        
            Logger.trace("onConnectionsChange", arguments, this);
            if (this.IS_UE) {
                this.input_type[slot] = (connect && link_info) ? this.graph?._nodes_by_id[link_info?.origin_id]?.outputs[link_info?.origin_slot]?.type 
                                                               : undefined;
                update_input_label(this, slot, app);
            }
            _lrc.mark_link_list_outdated();
            onConnectionsChange?.apply(side,slot,connect,link_info,output);
        };

        /*
        Toggle the group restriction.
        Any right click action on a node might make the link list dirty.
        */
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(_, options) {
            Logger.trace("getExtraMenuOptions", arguments, this);
            getExtraMenuOptions?.apply(this, arguments);
            if (is_UEnode(this)) {
                options.push(null,
                    {
                        content: (this.properties.group_restricted) ? "Remove group restriction" : "Send only within my group(s)",
                        callback: () => { this.properties.group_restricted = !this.properties.group_restricted; }
                    }, 
                null)
            }
            // any right click action can make the list dirty
            inject_outdating_into_objects(options,'callback',`menu option on ${this.id}`);
        }

        if (is_UEnode(nodeType)) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                if (!this.properties) this.properties = {}
                this.properties.group_restricted = false;
                return r;
            }
        }
    },

    async nodeCreated(node) {
        node.IS_UE = is_UEnode(node);
        if (node.IS_UE) {
            node.input_type = [undefined, undefined, undefined]; // for dynamic input types
            node.displayMessage = displayMessage;                // receive messages from the python code           

            // If a widget on a UE node is edited, link list is dirty
            inject_outdating_into_objects(node.widgets,'callback',`widget callback on ${this.id}`);

            // draw the indication of group restrictions
            const original_onDrawTitleBar = node.onDrawTitleBar;
            node.onDrawTitleBar = function(ctx, title_height) {
                original_onDrawTitleBar?.apply(this, arguments);
                if (node.properties.group_restricted) indicate_group_restriction(ctx, title_height);
            }
        }

        // removing a node makes the list dirty
        inject_outdating_into_object_method(node, 'onRemoved', `node ${node.id} removed`)

        // creating a node makes the link list dirty - but give the system a moment to finish
        setTimeout( ()=>{_lrc.mark_link_list_outdated()}, 100 );
    },

	async setup() {
        /*
        Listen for message-handler event from python code
        */
        function messageHandler(event) {
            const id = event.detail.id;
            const message = event.detail.message;
            const node = app.graph._nodes_by_id[id];
            if (node && node.displayMessage) node.displayMessage(id, message);
            else (console.log(`node ${id} couldn't handle a message`));
        }
        api.addEventListener("ue-message-handler", messageHandler);

        /*
        The graphToPrompt method is called when the app is going to send a prompt to the server.
        We hijack it, call the original, and return a modified copy.
        */
        _original_graphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            return analyse_graph(true);
        }

        /* 
        Hijack drawNode to render the virtual links if requested
        */
        const original_drawNode = LGraphCanvas.prototype.drawNode;
        LGraphCanvas.prototype.drawNode = function(node, ctx) {
            // don't trace - this is called way too often!
            original_drawNode.apply(this, arguments);
            _lrc.render_ue_links(node, ctx);
        }

        /* 
        Add to the settings menu 
        */
        app.ui.settings.addSetting({
            id: "AE.details",
            name: "Anything Everywhere show node details",
            type: "boolean",
            defaultValue: false,
        });
        app.ui.settings.addSetting({
            id: "AE.checkloops",
            name: "Anything Everywhere check loops",
            type: "boolean",
            defaultValue: true,
        });

        /* 
        Canvas menu is the right click on backdrop.
        We need to add our option, and hijack the others.
        */
        const original_getCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;
        LGraphCanvas.prototype.getCanvasMenuOptions = function () {
            // Add our items to the canvas menu 
            const options = original_getCanvasMenuOptions.apply(this, arguments);
            options.push(null); // divider
            options.push({
                content: `Toggle UE link visibility`,
                callback: () => {
                    Logger.trace("Toggle visibility called", arguments);
                    _lrc.toggle_ue_links_visible();
                }
            });
            options.push(null); // divider

            //  every menu item makes our list dirty
            inject_outdating_into_objects(options,'callback',`menu option on canvas`);

            return options;
        }

        /*
        most things that change the graph call afterChange
        */
        inject_outdating_into_object_method(app.graph, "afterChange", "graph.afterChange")

	},

});
