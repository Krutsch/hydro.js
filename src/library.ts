declare const window: any;
declare global {
  interface Window {
    $: Document["querySelector"];
    $$: Document["querySelectorAll"];
  }
  interface Number {
    setter(val: any): void;
  }
  interface String {
    setter(val: any): void;
  }
  interface Symbol {
    setter(val: any): void;
  }
  interface Boolean {
    setter(val: any): void;
  }
  interface BigInt {
    setter(val: any): void;
  }
  interface Object {
    setter(val: any): void;
  }
  interface Navigator {
    scheduling: {
      isInputPending(IsInputPendingOptions?: isInputPendingOptions): boolean;
    };
  }
}
type isInputPendingOptions = {
  includeContinuous: boolean;
};

interface hydroObject extends Record<keyof any, any> {
  isProxy: boolean;
  asyncUpdate: boolean;
  observe: (key: keyof any, fn: Function) => any;
  getObservers: () => Map<string, Set<Function>>;
  unobserve: (key?: keyof any, handler?: Function) => undefined;
}
type nodeChange = Array<[number, number, string | undefined]>;

// Circular reference
type nodeToChangeMap = Map<
  Element | Text | nodeChange,
  Element | Text | nodeChange
>;
interface keyToNodeMap extends Map<string, nodeToChangeMap> {}
interface EventObject {
  event: EventListener;
  options: AddEventListenerOptions;
}
type reactiveObject<T> = T & hydroObject & ((setter: any) => void);
type eventFunctions = Record<string, EventListener | EventObject>;

const enum Placeholder {
  attribute = "attribute",
  text = "text",
  string = "string",
  isProxy = "isProxy",
  asyncUpdate = "asyncUpdate",
  function = "function",
  template = "template",
  event = "event",
  options = "options",
  reactive = "reactive",
  observe = "observe",
  getObservers = "getObservers",
  unobserve = "unobserve",
  keys = "__keys__",
  twoWay = "two-way",
  change = "change",
  radio = "radio",
  checkbox = "checkbox",
  dummy = "-dummy",
}

// Safari Polyfills
window.requestIdleCallback =
  /* c8 ignore next 4 */
  window.requestIdleCallback ||
  ((cb: Function, _: any, start = performance.now()) =>
    setTimeout(cb, 0, {
      didTimeout: false,
      timeRemaining: () => Math.max(0, 5 - (performance.now() - start)),
    }));
// Safari Polyfills END

// Parser to create HTML elements from strings
const parser = ((range = document.createRange()) => {
  range.selectNodeContents(
    range.createContextualFragment(`<${Placeholder.template}>`).lastChild!
  );
  return range.createContextualFragment.bind(range);
})();
const allNodeChanges = new WeakMap<Text | Element, nodeChange>(); // Maps a Node against a change. This is necessary for nodes that have multiple changes for one text / attribute.
const elemEventFunctions = new WeakMap<Element, Array<EventListener>>(); // Stores event functions in order to compare Elements against each other.
const reactivityMap = new WeakMap<hydroObject, keyToNodeMap>(); // Maps Proxy Objects
const bindMap = new WeakMap<hydroObject, Array<Element>>(); // Bind an Element to Data. If the Data is being unset, the DOM Element disappears too.
const tmpSwap = new WeakMap<hydroObject, keyToNodeMap>(); // Take over keyToNodeMap if new value is a hydro Proxy. Save old reactivityMap entry here, in case for a swap operation. [if reuseElements]
const onRenderMap = new WeakMap<ReturnType<typeof html>, Function>(); // Lifecycle Hook that is being called after rendering
const onCleanupMap = new WeakMap<ReturnType<typeof html>, Function>(); // Lifecycle Hook that is being called when unmount function is being called
const fragmentToElements = new WeakMap<DocumentFragment, Array<ChildNode>>(); // Used to retreive Elements from DocumentFragment after it has been rendered – for diffing
const _boundFunctions = Symbol("boundFunctions"); // Cache for bound functions in Proxy, so that we create the bound version of each function only once

let globalSchedule = true; // Decides whether to schedule rendering and updating (async)
let reuseElements = true; // Reuses Elements when rendering
let insertBeforeDiffing = false;
let shouldSetReactivity = true;
let viewElements = false;

const reactivityRegex = /\{\{((\s|.)*?)\}\}/;
const HTML_FIND_INVALID = /<(\/?)(html|head|body)(>|\s.*?>)/g;
const newLineRegex = /\n/g;
const propChainRegex = /[\.\[\]]/;
const onEventRegex = /^on/;

// https://html.spec.whatwg.org/#attributes-3
// if value for bool attr is falsy, then remove attr
const boolAttrList = [
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
];
let lastSwapElem: null | Element = null;
let internReset = false;

function isObject(obj: object | unknown): obj is Record<string, any> {
  return obj != null && typeof obj === "object";
}
function isFunction(func: Function | unknown): func is Function {
  return typeof func === Placeholder.function;
}
function isTextNode(node: Node): node is Text {
  return (node as Text).splitText !== undefined;
}
function isNode(node: Node): node is Node {
  return node instanceof Node;
}
function isDocumentFragment(node: Node): node is DocumentFragment {
  // getElementById exists in svg too. I did not find a better way to identify a DocumentFragment
  return node.nodeName !== "svg" && "getElementById" in node;
}
function isEventObject(obj: object | unknown): obj is EventObject {
  return (
    isObject(obj) && Placeholder.event in obj && Placeholder.options in obj
  );
}
function isProxy(hydroObject: any): hydroObject is hydroObject {
  return Reflect.get(hydroObject, Placeholder.isProxy);
}
function isPromise(obj: any): obj is Promise<any> {
  return isObject(obj) && typeof obj.then === "function";
}

function setGlobalSchedule(willSchedule: boolean): void {
  globalSchedule = willSchedule;
  setHydroRecursive(hydro, willSchedule);
}
function setReuseElements(willReuse: boolean): void {
  reuseElements = willReuse;
}
function setInsertDiffing(willInsert: boolean): void {
  insertBeforeDiffing = willInsert;
}
function setShouldSetReactivity(willSet: boolean): void {
  shouldSetReactivity = willSet;
}
function setHydroRecursive(obj: hydroObject, willSchedule: boolean) {
  Reflect.set(obj, Placeholder.asyncUpdate, willSchedule);

  Object.values(obj).forEach((value) => {
    if (isObject(value) && isProxy(value)) {
      setHydroRecursive(value, willSchedule);
    }
  });
}

function randomText() {
  return Math.random().toString(32).slice(2);
}
function setAttribute(node: Element, key: string, val: any): boolean {
  if (boolAttrList.includes(key) && !val) {
    node.removeAttribute(key);
    return false;
  }

  node.setAttribute(key, val);
  return true;
}
function addEventListener(
  node: Element,
  eventName: string,
  obj: EventObject | EventListener
) {
  node.addEventListener(
    eventName,
    isFunction(obj) ? obj : obj.event,
    isFunction(obj) ? {} : obj.options
  );
}
// That is fine because the render function only renders within a body without a where parameter
function html(
  htmlArray: TemplateStringsArray, // The Input String, which is splitted by the template variables
  ...variables: Array<any>
): Element | DocumentFragment | Text {
  const eventFunctions: eventFunctions = {}; // Temporarily store a mapping for string -> function, because eventListener have to be registered after the Element's creation
  let insertNodes: Node[] = []; // Array of Nodes, that have to be added after the parsing

  const resolvedVariables = variables.map((variable, index) => {
    const template = `<${Placeholder.template} id="lbInsertNodes${index}"></${Placeholder.template}>`;

    switch (variable) {
      case isNode(variable) && variable:
        insertNodes.push(variable);
        return template;
      case ([
        "number",
        Placeholder.string,
        "symbol",
        "boolean",
        "bigint",
      ].includes(typeof variable) ||
        Reflect.get(variable, Placeholder.reactive)) &&
        variable:
        return String(variable);
      case (isFunction(variable) || isEventObject(variable)) && variable:
        const funcName = randomText();
        Reflect.set(eventFunctions, funcName, variable);
        return funcName;
      case Array.isArray(variable) && variable:
        variable.forEach((item: any, index: number) => {
          if (isNode(item)) {
            insertNodes.push(item);
            variable[index] = template;
          }
        });
        return variable.join("");
      case isObject(variable) && variable:
        let result = "";
        Object.entries(variable).forEach(([key, value]) => {
          if (isFunction(value) || isEventObject(value)) {
            const funcName = randomText();
            Reflect.set(eventFunctions, funcName, value);
            result += `${key}="${funcName}"`;
          } else {
            result += `${key}="${value}"`;
          }
        });
        return result;
    }
    /* c8 ignore next 1 */
  });

  // Find elements <html|head|body>, as they cannot be created by the parser. Replace them by fake Custom Elements and replace them afterwards.
  let DOMString = String.raw(htmlArray, ...resolvedVariables).trim();
  DOMString = DOMString.replace(
    HTML_FIND_INVALID,
    `<$1$2${Placeholder.dummy}$3`
  );
  const DOM = parser(DOMString);

  // Delay Elemen iteration and manipulation after the elements have been added to the DOM.
  if (viewElements) {
    onRender(
      fillDOM,
      DOM.firstChild as Element,
      DOM.firstChild,
      insertNodes,
      eventFunctions
    );
  } else {
    fillDOM(DOM, insertNodes, eventFunctions);
  }

  // Return DocumentFragment
  if (DOM.childNodes.length > 1) return DOM;

  // Return Text Node
  if (!DOM.firstChild) return document.createTextNode("");

  // Return Element
  return DOM.firstChild as Element;
}
function fillDOM(
  elem: DocumentFragment | Element,
  insertNodes: Node[],
  eventFunctions: eventFunctions
) {
  const root = document.createNodeIterator(elem, NodeFilter.SHOW_ELEMENT, {
    acceptNode(element: Element) {
      return element.localName.endsWith(Placeholder.dummy)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let nextNode;
  while ((nextNode = root.nextNode())) {
    const tag = (nextNode as Element).localName.replace(Placeholder.dummy, "");
    const replacement = document.createElement(tag);

    //@ts-ignore
    replacement.append(...(nextNode as Element).childNodes);
    (nextNode as Element).replaceWith(replacement);
  }

  // Insert HTML Elements, which were stored in insertNodes
  elem
    .querySelectorAll("template[id^=lbInsertNodes]")
    .forEach((template) => template.replaceWith(insertNodes.shift()!));

  if (shouldSetReactivity) setReactivity(elem, eventFunctions);
}
/* c8 ignore start */
function h(
  name: string | ((...args: any[]) => ReturnType<typeof h>),
  props: Record<keyof any, any> | null,
  ...children: Array<any>
): ReturnType<typeof html> {
  if (isFunction(name)) return name(props);

  const flatChildren = children
    .map((child: any) =>
      isObject(child) && !isNode(child as Node) ? Object.values(child) : child
    )
    .flat();
  const elem = document.createElement(name);
  for (let i in props) {
    //@ts-ignore
    i in elem ? (elem[i] = props[i]) : setAttribute(elem, i, props[i]);
  }

  elem.append(...flatChildren);
  onRender(setReactivity, elem, elem);
  return elem;
}
/* c8 ignore end */
function setReactivity(DOM: Node, eventFunctions?: eventFunctions) {
  // Set events and reactive behaviour(checks for {{ key }} where key is on hydro)
  const root = document.createNodeIterator(DOM, NodeFilter.SHOW_ELEMENT);
  let elem: Element;
  while ((elem = root.nextNode() as Element)) {
    // Check Attributes
    elem.getAttributeNames().forEach((key) => {
      // Set functions
      if (eventFunctions && key.startsWith("on")) {
        const eventName = key!.replace(onEventRegex, "");
        const event = eventFunctions[elem.getAttribute(key)!];
        if (!event) {
          setReactivitySingle(elem, key);
          return;
        }
        elem.removeAttribute(key);

        if (isEventObject(event)) {
          elem.addEventListener(eventName, event.event, event.options);
          if (elemEventFunctions.has(elem)) {
            elemEventFunctions.get(elem)!.push(event.event);
          } else {
            elemEventFunctions.set(elem, [event.event]);
          }
        } else {
          elem.addEventListener(eventName, event);
          if (elemEventFunctions.has(elem)) {
            elemEventFunctions.get(elem)!.push(event as EventListener);
          } else {
            elemEventFunctions.set(elem, [event as EventListener]);
          }
        }
      } else {
        setReactivitySingle(elem, key);
      }
    });

    // Check Text Nodes
    // This is somehow faster than createNodeIterator and createTreeWalker
    // https://esbench.com/bench/5e9c421c12464000a01e4359
    let childNode = elem.firstChild;
    while (childNode) {
      if (isTextNode(childNode)) {
        setReactivitySingle(childNode);
      }
      childNode = childNode.nextSibling;
    }
  }
}
function setReactivitySingle(node: Text): void; // TS function overload
function setReactivitySingle(node: Element, key: string): void; // TS function overload
function setReactivitySingle(node: Element | Text, key?: string): void {
  let attr_OR_text: string, match: RegExpMatchArray | null;

  if (isTextNode(node)) {
    attr_OR_text = node.nodeValue!; // nodeValue is (always) defined on Text Nodes
  } else {
    attr_OR_text = (node as Element).getAttribute(key!)!;
    if (attr_OR_text! === "") {
      // e.g. checked attribute or two-way attribute
      attr_OR_text = key!;

      if (attr_OR_text.startsWith("{{")) {
        node.removeAttribute(attr_OR_text);
      }
    }
  }

  while ((match = attr_OR_text.match(reactivityRegex))) {
    // attr_OR_text will be altered in every iteration

    const [hydroMatch, hydroPath] = match;
    const properties = hydroPath
      .trim()
      .replace(newLineRegex, "")
      .split(propChainRegex)
      .filter(Boolean);
    const [resolvedValue, resolvedObj] = resolveObject(properties);
    let lastProp = properties[properties.length - 1];
    const start = match.index!;
    let end: number = start + String(resolvedValue).length;

    if (isNode(resolvedValue)) {
      node.nodeValue = attr_OR_text.replace(hydroMatch, "");
      node.after(resolvedValue);
      setTraces(
        start,
        end,
        resolvedValue as Element | Text,
        lastProp,
        resolvedObj,
        key
      );
      return;
    }

    // Set Text or set Attribute
    if (isTextNode(node)) {
      const textContent = isObject(resolvedValue)
        ? JSON.stringify(resolvedValue)
        : resolvedValue ?? "";

      attr_OR_text = attr_OR_text.replace(hydroMatch, textContent);
      if (attr_OR_text != null) {
        node.nodeValue = attr_OR_text;
      }
    } else {
      if (key === "bind") {
        attr_OR_text = attr_OR_text.replace(hydroMatch, "");
        node.removeAttribute(key);

        const proxy =
          isObject(resolvedValue) && isProxy(resolvedValue)
            ? resolvedValue
            : resolvedObj;
        if (bindMap.has(proxy)) {
          bindMap.get(proxy)!.push(node);
        } else {
          bindMap.set(proxy, [node]);
        }
        continue;
      } else if (key === Placeholder.twoWay) {
        // Same behavior as v-model in https://v3.vuejs.org/guide/forms.html#basic-usage
        const changeAttrVal = (eventName: string) => {
          node.addEventListener(
            eventName,
            ({ target }: { target: EventTarget | null }) => {
              Reflect.set(
                resolvedObj,
                lastProp,
                (target as HTMLInputElement).value
              );
            }
          );
        };

        if (
          node instanceof HTMLTextAreaElement ||
          (node instanceof HTMLInputElement && node.type === Placeholder.text)
        ) {
          node.value = resolvedValue;
          changeAttrVal("input");
        } else if (node instanceof HTMLSelectElement) {
          node.value = resolvedValue;
          changeAttrVal(Placeholder.change);
        } else if (
          node instanceof HTMLInputElement &&
          node.type === Placeholder.radio
        ) {
          node.checked = node.value === resolvedValue;
          changeAttrVal(Placeholder.change);
        } else if (
          node instanceof HTMLInputElement &&
          node.type === Placeholder.checkbox
        ) {
          node.checked = resolvedValue.includes(node.name);
          node.addEventListener(Placeholder.change, ({ target }) => {
            if (!(target as HTMLInputElement).checked) {
              resolvedValue.splice(resolvedValue.indexOf(node.name), 1);
            } else if (!resolvedValue.includes(node.name)) {
              resolvedValue.push(node.name);
            }
          });
        }

        attr_OR_text = attr_OR_text.replace(hydroMatch, "");
        node.setAttribute(Placeholder.twoWay, "");
      } else if (isFunction(resolvedValue) || isEventObject(resolvedValue)) {
        attr_OR_text = attr_OR_text.replace(hydroMatch, "");
        node.removeAttribute(key!);
        addEventListener(node, key!.replace(onEventRegex, ""), resolvedValue);
      } else if (isObject(resolvedValue)) {
        // Case: setting attrs on Element - <p ${props}>

        Object.entries(resolvedValue).forEach(([subKey, subVal]) => {
          attr_OR_text = attr_OR_text.replace(hydroMatch, "");
          if (isFunction(subVal) || isEventObject(subVal)) {
            addEventListener(node, subKey.replace(onEventRegex, ""), subVal);
          } else {
            lastProp = subKey;

            if (setAttribute(node, subKey, subVal)) {
              end = start + String(subVal).length;
            } else {
              end = start;
            }
          }

          setTraces(
            start,
            end,
            node,
            lastProp,
            resolvedValue as hydroObject,
            subKey
          );
        });

        continue; // As we set all Mappings via subKeys
      } else {
        attr_OR_text = attr_OR_text.replace(hydroMatch, resolvedValue);

        if (
          !setAttribute(
            node,
            key!,
            attr_OR_text === String(resolvedValue)
              ? resolvedValue
              : attr_OR_text
          )
        ) {
          attr_OR_text = attr_OR_text.replace(resolvedValue, "");
        }
      }
    }

    setTraces(start, end, node, lastProp, resolvedObj, key);
  }
}
function setTraces(
  start: number,
  end: number,
  node: Text | Element,
  hydroKey: string,
  resolvedObj: hydroObject,
  key?: string
): void {
  // Set WeakMaps, that will be used to track a change for a Node but also to check if a Node has any other changes.
  const change = [start, end, key] as nodeChange[number];
  const changeArr = [change];

  if (allNodeChanges.has(node)) {
    allNodeChanges.get(node)!.push(change);
  } else {
    allNodeChanges.set(node, changeArr);
  }

  if (reactivityMap.has(resolvedObj)) {
    const keyToNodeMap = reactivityMap.get(resolvedObj)!;
    const nodeToChangeMap = keyToNodeMap.get(hydroKey)!;

    if (nodeToChangeMap) {
      if (nodeToChangeMap.has(node)) {
        (nodeToChangeMap.get(node)! as nodeChange).push(change);
      } else {
        nodeToChangeMap.set(changeArr, node);
        nodeToChangeMap.set(node, changeArr);
      }
    } else {
      keyToNodeMap.set(
        hydroKey,
        //@ts-ignore // ts-bug
        new Map([
          [changeArr, node],
          [node, changeArr],
        ])
      );
    }
  } else {
    reactivityMap.set(
      resolvedObj,

      new Map([
        [
          hydroKey,
          //@ts-ignore // ts-bug
          new Map([
            [changeArr, node],
            [node, changeArr],
          ]),
        ],
      ])
    );
  }
}
// Helper function to return a Hydro Obj with a aalue from a chain of properties on hydro
function resolveObject(propertyArray: Array<keyof any>): [any, hydroObject] {
  let value: any, prev: hydroObject;
  value = prev = hydro;

  propertyArray.forEach((prop) => {
    prev = value;
    value = Reflect.get(prev, prop);
  });

  return [value, prev];
}

function compareEvents(
  elem: Element | Text,
  where: Element | Text,
  onlyTextChildren?: boolean
): boolean {
  const elemFunctions = [];
  const whereFunctions = [];

  if (isTextNode(elem)) {
    if (onRenderMap.has(elem)) {
      elemFunctions.push(onRenderMap.get(elem)!);
    }
    if (onCleanupMap.has(elem)) {
      elemFunctions.push(onCleanupMap.get(elem)!);
    }
    if (onRenderMap.has(where)) {
      whereFunctions.push(onRenderMap.get(where)!);
    }
    if (onCleanupMap.has(where)) {
      whereFunctions.push(onCleanupMap.get(where)!);
    }

    if (elemFunctions.length !== whereFunctions.length) return false;
    if (String(elemFunctions) !== String(whereFunctions)) return false;

    return true;
  }

  if (elemEventFunctions.has(elem)) {
    elemFunctions.push(...elemEventFunctions.get(elem)!);
  }
  if (elemEventFunctions.has(where as Element)) {
    whereFunctions.push(...elemEventFunctions.get(where as Element)!);
  }

  if (onRenderMap.has(elem)) {
    elemFunctions.push(onRenderMap.get(elem)!);
  }
  if (onCleanupMap.has(elem)) {
    elemFunctions.push(onCleanupMap.get(elem)!);
  }
  if (onRenderMap.has(where)) {
    whereFunctions.push(onRenderMap.get(where)!);
  }
  if (onCleanupMap.has(where)) {
    whereFunctions.push(onCleanupMap.get(where)!);
  }

  if (elemFunctions.length !== whereFunctions.length) return false;
  if (String(elemFunctions) !== String(whereFunctions)) return false;

  for (let i = 0; i < elem.childNodes.length; i++) {
    if (onlyTextChildren) {
      if (isTextNode(elem.childNodes[i])) {
        if (
          !compareEvents(
            elem.childNodes[i] as Text,
            where.childNodes[i] as Text,
            onlyTextChildren
          )
        ) {
          return false;
        }
      }
    } else {
      if (
        !compareEvents(
          elem.childNodes[i] as Element | Text,
          where.childNodes[i] as Element | Text
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

function compare(
  elem: Element,
  where: Element,
  onlyTextChildren?: boolean
): boolean {
  return (
    elem.isEqualNode(where) && compareEvents(elem, where, onlyTextChildren)
  );
}

function render(
  elem: ReturnType<typeof html> | reactiveObject<any>,
  where: ReturnType<typeof html> | string = "",
  shouldSchedule = globalSchedule
): ChildNode["remove"] {
  /* c8 ignore next 4 */
  if (shouldSchedule) {
    schedule(render, elem, where, false);
    return unmount(elem);
  }

  // Get elem value if elem is reactiveObject
  if (Reflect.get(elem, Placeholder.reactive)) {
    elem = getValue(elem);
  }

  // Store Elements of DocumentFragment for later unmount
  let elemChildren: Array<ChildNode>;
  if (isDocumentFragment(elem)) {
    elemChildren = Array.from(elem.childNodes);
    fragmentToElements.set(elem, elemChildren); // For diffing later
  }

  if (!where) {
    document.body.append(elem);
  } else {
    if (typeof where === Placeholder.string) {
      const resolveStringToElement = document.querySelector(where as string);
      if (resolveStringToElement) {
        where = resolveStringToElement;
      } else {
        return () => {};
      }
    }

    if (!reuseElements) {
      replaceElement(elem, where as Element);
      runLifecyle(where as Element, onCleanupMap);
    } else {
      if (isTextNode(elem)) {
        replaceElement(elem, where as Element);
        runLifecyle(where as Element, onCleanupMap);
      } else if (!compare(elem, where as Element)) {
        treeDiff(elem, where as Element);
      }
    }
  }

  runLifecyle(elem, onRenderMap);
  elemChildren!?.forEach((subElem) => {
    runLifecyle(subElem as Element | Text, onRenderMap);
  });

  return unmount(isDocumentFragment(elem) ? elemChildren! : elem);
}

function executeLifecycle(
  node: ReturnType<typeof html>,
  lifecyleMap: typeof onRenderMap | typeof onCleanupMap
) {
  if (lifecyleMap.has(node)) {
    const fn = lifecyleMap.get(node)!;

    if (viewElements) {
      schedule(fn);
      /* c8 ignore next 3 */
    } else if (globalSchedule) {
      window.requestIdleCallback(fn);
    } else {
      fn();
    }

    lifecyleMap.delete(node as Element);
  }
}
function runLifecyle(
  node: ReturnType<typeof html>,
  lifecyleMap: typeof onRenderMap | typeof onCleanupMap
) {
  if (
    (lifecyleMap === onRenderMap && !calledOnRender) ||
    (lifecyleMap === onCleanupMap && !calledOnCleanup)
  )
    return;

  executeLifecycle(node, lifecyleMap);

  const elements = document.createNodeIterator(
    node as Node,
    NodeFilter.SHOW_ELEMENT
  );

  let subElem;
  while ((subElem = elements.nextNode())) {
    executeLifecycle(subElem as Element, lifecyleMap);

    let childNode = subElem.firstChild;
    while (childNode) {
      if (isTextNode(childNode)) {
        executeLifecycle(childNode as Text, lifecyleMap);
      }
      childNode = childNode.nextSibling;
    }
  }
}

function filterTag2Elements(
  tag2Elements: Map<string, Array<Element>>,
  root: Element
) {
  for (const [localName, list] of tag2Elements.entries()) {
    for (let i = 0; i < list.length; i++) {
      const elem = list[i];

      if (root.contains(elem) || root.isSameNode(elem)) {
        list.splice(i, 1);
        i--;
      }
      if (list.length === 0) {
        tag2Elements.delete(localName);
      }
    }
  }
}
function treeDiff(elem: Element | DocumentFragment, where: Element) {
  const elemElements = document.createNodeIterator(
    elem,
    NodeFilter.SHOW_ELEMENT
  );
  const whereElements = document.createNodeIterator(
    where,
    NodeFilter.SHOW_ELEMENT
  );

  let template: HTMLTemplateElement;
  if (insertBeforeDiffing) {
    template = document.createElement(Placeholder.template);
    /* c8 ignore next 3 */
    if (where === document.documentElement) {
      where.append(template);
    } else {
      if (isDocumentFragment(where)) {
        fragmentToElements.get(where)![0].before(template);
      } else {
        where.before(template);
      }
    }
    template.append(elem);
  }

  // Create Mapping for easier diffing, eg: "div" -> [...Element]
  let wElem: Element;
  const tag2Elements = new Map<string, Array<Element>>();
  while ((wElem = whereElements.nextNode() as Element)) {
    /* c8 ignore next 2 */
    if (insertBeforeDiffing && wElem === template!) continue;

    if (tag2Elements.has(wElem.localName)) {
      tag2Elements.get(wElem.localName)!.push(wElem);
    } else {
      tag2Elements.set(wElem.localName, [wElem]);
    }
  }

  // Re-use any where Element if possible, then remove elem Element
  let subElem: Element;
  while ((subElem = elemElements.nextNode() as Element)) {
    const sameElements = tag2Elements!.get(subElem.localName);

    if (sameElements) {
      for (let index = 0; index < sameElements.length; index++) {
        const whereElem = sameElements[index];

        if (compare(subElem, whereElem, true)) {
          subElem.replaceWith(whereElem);
          runLifecyle(subElem, onCleanupMap);
          filterTag2Elements(tag2Elements, whereElem);
          break;
        }
      }
    }
  }

  if (insertBeforeDiffing) {
    const newElems = isDocumentFragment(elem)
      ? Array.from(template!.childNodes)
      : [elem];
    if (isDocumentFragment(where)) {
      const oldElems = fragmentToElements.get(where)!;
      newElems.forEach((e) => oldElems[0].before(e));
      oldElems.forEach((e) => e.remove());
    } else {
      where.replaceWith(...newElems);
    }
    template!.remove();
    runLifecyle(where, onCleanupMap);
  } else {
    replaceElement(elem, where);
    runLifecyle(where, onCleanupMap);
  }
  tag2Elements.clear();
}

function replaceElement(
  elem: ReturnType<typeof html>,
  where: ReturnType<typeof html>
) {
  if (isDocumentFragment(where)) {
    const fragmentChildren = fragmentToElements.get(where)!;
    if (isDocumentFragment(elem)) {
      const fragmentElements = Array.from(elem.childNodes);
      fragmentChildren.forEach((fragWhere, index) => {
        if (index < fragmentElements.length) {
          render(fragmentElements[index], fragWhere as Element);
        } else {
          fragWhere.remove();
        }
      });
    } else {
      fragmentChildren.forEach((fragWhere, index) => {
        if (index === 0) {
          render(elem, fragWhere as Element);
        } else {
          fragWhere.remove();
        }
      });
    }
  } else {
    where.replaceWith(elem);
  }
}

function unmount<T = ReturnType<typeof html> | Array<ChildNode>>(elem: T) {
  if (Array.isArray(elem)) {
    return () => elem.forEach(removeElement);
  } else {
    return () => removeElement((elem as unknown) as Text | Element);
  }
}

function removeElement(elem: Text | Element) {
  if (elem.isConnected) {
    elem.remove();
    runLifecyle(elem, onCleanupMap);
  }
}

/* c8 ignore next 13 */
function schedule(fn: Function, ...args: any): void {
  if (navigator.scheduling) {
    if (navigator.scheduling.isInputPending()) {
      setTimeout(schedule, 0, fn, ...args);
    } else {
      fn(...args);
    }
  } else {
    window.requestIdleCallback(() => fn(...args));
  }
}

function reactive<T>(initial: T): reactiveObject<T> {
  let key: string;

  do key = randomText();
  while (Reflect.has(hydro, key));

  Reflect.set(hydro, key, initial);
  Reflect.set(setter, Placeholder.reactive, true);

  const chainKeysProxy = chainKeys(setter, [key]);
  return chainKeysProxy;

  function setter<U>(val: U) {
    // @ts-ignore
    const keys = (this && Reflect.get(this, Placeholder.reactive)
      ? // @ts-ignore
        this
      : chainKeysProxy)[Placeholder.keys];
    const [resolvedValue, resolvedObj] = resolveObject(keys);
    const lastProp = keys[keys.length - 1];

    if (isFunction(val)) {
      const returnVal = val(resolvedValue);
      const sameObject = resolvedValue === returnVal;
      if (sameObject) return;

      Reflect.set(resolvedObj, lastProp, returnVal ?? resolvedValue);
    } else {
      Reflect.set(resolvedObj, lastProp, val);
    }
  }
}
function chainKeys(initial: Function | any, keys: Array<keyof any>): any {
  return new Proxy(initial, {
    get(target, subKey, _receiver) {
      if (subKey === Placeholder.reactive) return true;
      if (subKey === Placeholder.keys) {
        return keys;
      }

      if (subKey === Symbol.toPrimitive) {
        return () => `{{${keys.join(".")}}}`;
      }

      return chainKeys(target, [...keys, subKey]) as hydroObject &
        ((setter: any) => void);
    },
  });
}
function getReactiveKeys(reactiveHydro: reactiveObject<any>) {
  const keys = reactiveHydro[Placeholder.keys];
  const lastProp = keys[keys.length - 1];
  return [lastProp, keys.length === 1];
}
function unset(reactiveHydro: reactiveObject<any>): void {
  const [lastProp, oneKey] = getReactiveKeys(reactiveHydro);

  if (oneKey) {
    Reflect.set(hydro, lastProp, null);
  } else {
    const [_, resolvedObj] = resolveObject(reactiveHydro[Placeholder.keys]);
    Reflect.set(resolvedObj, lastProp, null);
  }
}
function setAsyncUpdate(
  reactiveHydro: reactiveObject<any>,
  asyncUpdate: boolean
) {
  const [_, oneKey] = getReactiveKeys(reactiveHydro);

  if (oneKey) {
    hydro.asyncUpdate = asyncUpdate;
  } else {
    const [_, resolvedObj] = resolveObject(reactiveHydro[Placeholder.keys]);
    resolvedObj.asyncUpdate = asyncUpdate;
  }
}
function observe(reactiveHydro: reactiveObject<any>, fn: Function) {
  const [lastProp, oneKey] = getReactiveKeys(reactiveHydro);

  if (oneKey) {
    hydro.observe(lastProp, fn);
  } else {
    const [_, resolvedObj] = resolveObject(reactiveHydro[Placeholder.keys]);
    resolvedObj.observe(lastProp, fn);
  }
}
function unobserve(reactiveHydro: reactiveObject<any>) {
  const [lastProp, oneKey] = getReactiveKeys(reactiveHydro);

  if (oneKey) {
    hydro.unobserve(lastProp);
  } else {
    const [_, resolvedObj] = resolveObject(reactiveHydro[Placeholder.keys]);
    resolvedObj.unobserve(lastProp);
  }
}
function ternary(
  condition: Function | reactiveObject<any>,
  trueVal: any,
  falseVal: any,
  reactiveHydro: reactiveObject<any> = condition
) {
  const checkCondition = (cond: any) =>
    (
      !Reflect.get(condition, Placeholder.reactive) && isFunction(condition)
        ? condition(cond)
        : isPromise(cond)
        ? false
        : cond
    )
      ? isFunction(trueVal)
        ? trueVal()
        : trueVal
      : isFunction(falseVal)
      ? falseVal()
      : falseVal;

  const ternaryValue = reactive(checkCondition(getValue(reactiveHydro)));

  observe(reactiveHydro, (newVal: any) => {
    newVal === null
      ? unset(ternaryValue)
      : ternaryValue(checkCondition(newVal));
  });

  return ternaryValue;
}
function emit(
  eventName: string,
  data: any,
  who: EventTarget,
  options: object = { bubbles: true }
) {
  who.dispatchEvent(new CustomEvent(eventName, { ...options, detail: data }));
}
let trackDeps = false;
const trackProxies = new Set<hydroObject>();
const trackMap = new WeakMap<hydroObject, Set<keyof any>>();
const unobserveMap = new WeakMap<
  Function,
  Array<{ proxy: hydroObject; key: keyof any }>
>();
function watchEffect(fn: Function) {
  trackDeps = true;
  fn();
  trackDeps = false;

  const reRun = (newVal: keyof any) => {
    if (newVal !== null) fn();
  };

  trackProxies.forEach((proxy) => {
    trackMap.get(proxy)?.forEach((key) => {
      proxy.observe(key, reRun);

      if (unobserveMap.has(reRun)) {
        unobserveMap.get(reRun)!.push({ proxy, key });
      } else {
        unobserveMap.set(reRun, [{ proxy, key }]);
      }
    });
    trackMap.delete(proxy);
  });

  trackProxies.clear();

  return () =>
    unobserveMap
      .get(reRun)
      ?.forEach((entry) => entry.proxy.unobserve(entry.key, reRun));
}
function getValue<T extends object>(reactiveHydro: T): T {
  const [resolvedValue] = resolveObject(
    Reflect.get(reactiveHydro, Placeholder.keys)
  );
  return resolvedValue;
}

let calledOnRender = false;
function onRender(
  fn: Function,
  elem: ReturnType<typeof html>,
  ...args: Array<any>
) {
  calledOnRender = true;
  onRenderMap.set(elem, args.length ? fn.bind(fn, ...args) : fn);
}
let calledOnCleanup = false;
function onCleanup(
  fn: Function,
  elem: ReturnType<typeof html>,
  ...args: Array<any>
) {
  calledOnCleanup = true;
  onCleanupMap.set(elem, args.length ? fn.bind(fn, ...args) : fn);
}

// Core of the library
function generateProxy(obj = {}): hydroObject {
  const handlers = Symbol("handlers"); // For observer pattern
  const boundFunctions = new WeakMap<Function, Function>();

  const proxy = new Proxy(obj, {
    // If receiver is a getter, then it is the object on which the search first started for the property|key -> Proxy
    set(target, key, val, receiver) {
      if (trackDeps) {
        trackProxies.add(receiver);
        if (trackMap.has(receiver)) {
          trackMap.get(receiver)!.add(key);
        } else {
          trackMap.set(receiver, new Set([key]));
        }
      }

      let returnSet = true;
      let oldVal = Reflect.get(target, key, receiver);
      if (oldVal === val) return returnSet;

      // Reset Path - mostly GC
      if (val === null) {
        // Remove entry from reactitivyMap underlying Map
        if (reactivityMap.has(receiver)) {
          const key2NodeMap = reactivityMap.get(receiver)!;
          key2NodeMap.delete(String(key));
          if (key2NodeMap.size === 0) {
            reactivityMap.delete(receiver);
          }
        }

        // Inform the Observers about null change and unobserve
        const observer = Reflect.get(target, handlers, receiver);
        if (observer.has(key)) {
          let set = observer.get(key);
          set.forEach((handler: Function) => handler(null, oldVal));
          set.clear();
          receiver.unobserve(key);
        }

        // If oldVal is a Proxy - clean it
        if (isObject(oldVal) && isProxy(oldVal)) {
          reactivityMap.delete(oldVal);
          if (bindMap.has(oldVal)) {
            bindMap.get(oldVal)!.forEach(removeElement);
            bindMap.delete(oldVal);
          }
        } else {
          if (bindMap.has(receiver)) {
            bindMap.get(receiver)!.forEach(removeElement);
            bindMap.delete(receiver);
          }
        }

        // Remove item from array
        /* c8 ignore next 4 */
        if (!internReset && Array.isArray(receiver)) {
          receiver.splice((key as unknown) as number, 1);
          return returnSet;
        }

        return Reflect.deleteProperty(receiver, key);
      } else if (
        Array.isArray(oldVal) &&
        Array.isArray(val) &&
        val.length === 0
      ) {
        // Parent Array null -> set items to null too

        // Optimization Path
        Reflect.get(target, handlers, receiver)
          .get(key)
          ?.forEach((handler: Function) => handler(val, oldVal));

        internReset = true;
        const length = oldVal.length;
        for (let i = 0; i < length; i++) {
          let subItem = receiver[key][i];
          /* c8 ignore next 3 */
          if (isObject(subItem) && isProxy(subItem)) {
            receiver[key][i] = null;
          }
        }
        internReset = false;
      }

      // Set the value
      if (isPromise(val)) {
        const promise = val;
        promise
          .then((value) => {
            // No Reflect in order to trigger the Getter
            receiver[key] = value;
          })
          .catch((e) => {
            console.error(e);
            receiver[key] = null;
          });
        returnSet = Reflect.set(target, key, val, receiver);
        return returnSet;
      } else if (isNode(val)) {
        returnSet = Reflect.set(target, key, val, receiver);
      } else if (isObject(val) && !isProxy(val)) {
        returnSet = Reflect.set(target, key, generateProxy(val), receiver);

        // Recursively set properties to Proxys too
        Object.entries(val).forEach(([subKey, subVal]) => {
          if (isObject(subVal) && !isProxy(subVal)) {
            Reflect.set(val, subKey, generateProxy(subVal));
          }
        });
      } else {
        if (
          !reuseElements &&
          Array.isArray(receiver) &&
          receiver.includes(oldVal) &&
          receiver.includes(val) &&
          /* c8 ignore start */
          bindMap.has(val)
        ) {
          const [elem] = bindMap.get(val)!;
          if (lastSwapElem !== elem) {
            const [oldElem] = bindMap.get(oldVal)!;
            lastSwapElem = oldElem;

            const prevElem = elem.previousSibling!;
            const prevOldElem = oldElem.previousSibling!;

            // Move it in the array too without triggering the proxy set
            const index = receiver.findIndex((i) => i === val);
            receiver.splice(Number(key), 1, val);
            receiver.splice(index, 1, oldVal);

            prevElem.after(oldElem);
            prevOldElem.after(elem);
          }
          return true;
        } else {
          /* c8 ignore end */
          returnSet = Reflect.set(target, key, val, receiver);
        }
      }

      const newVal = Reflect.get(target, key, receiver);

      // Check if DOM needs to be updated
      // oldVal can be Proxy value too
      if (reactivityMap.has(oldVal)) {
        checkReactivityMap(oldVal, key, newVal, oldVal);
      } else if (reactivityMap.has(receiver)) {
        checkReactivityMap(receiver, key, newVal, oldVal);
      }

      // current val (before setting) is a proxy - take over its keyToNodeMap
      if (isObject(val) && isProxy(val)) {
        if (reactivityMap.has(oldVal)) {
          // Store old reactivityMap if it is a swap operation
          reuseElements && tmpSwap.set(oldVal, reactivityMap.get(oldVal)!);

          if (tmpSwap.has(val)) {
            reactivityMap.set(oldVal, tmpSwap.get(val)!);
            tmpSwap.delete(val);
          } else {
            reactivityMap.set(oldVal, reactivityMap.get(val)!);
          }
        }
      }

      // Inform the Observers
      if (returnSet) {
        Reflect.get(target, handlers, receiver)
          .get(key)
          ?.forEach((handler: Function) => handler(newVal, oldVal));
      }

      // If oldVal is a Proxy - clean it
      !reuseElements && cleanProxy(oldVal);

      return returnSet;
    },

    // fix proxy bugs, e.g Map
    get(target, prop, receiver) {
      if (trackDeps) {
        trackProxies.add(receiver);
        if (trackMap.has(receiver)) {
          trackMap.get(receiver)!.add(prop);
        } else {
          trackMap.set(receiver, new Set([prop]));
        }
      }
      const value = Reflect.get(target, prop, receiver);
      if (!isFunction(value)) {
        return value;
      }

      if (!boundFunctions.has(value)) {
        boundFunctions.set(value, value.bind(target));
      }
      return boundFunctions.get(value);
    },
  } as ProxyHandler<hydroObject>);

  Reflect.defineProperty(proxy, Placeholder.isProxy, {
    value: true,
  });
  Reflect.defineProperty(proxy, Placeholder.asyncUpdate, {
    value: globalSchedule,
    writable: true,
  });
  Reflect.defineProperty(proxy, handlers, {
    value: new Map<keyof any, Set<Function>>(),
  });
  Reflect.defineProperty(proxy, Placeholder.observe, {
    value: (key: keyof any, handler: Function) => {
      const map = Reflect.get(proxy, handlers);

      if (map.has(key)) {
        map.get(key).add(handler);
      } else {
        map.set(key, new Set([handler]));
      }
    },
    configurable: true,
  });
  Reflect.defineProperty(proxy, Placeholder.getObservers, {
    value: () => Reflect.get(proxy, handlers),
    configurable: true,
  });
  Reflect.defineProperty(proxy, Placeholder.unobserve, {
    value: (key: keyof any, handler: Function) => {
      const map = Reflect.get(proxy, handlers);

      if (key) {
        if (map.has(key)) {
          if (handler == null) {
            map.delete(key);
          } else {
            const set = map.get(key);
            if (set?.has(handler)) {
              set.delete(handler);
            }
          }
        }
        /* c8 ignore next 3 */
      } else {
        map.clear();
      }
    },
    configurable: true,
  });
  if (!Reflect.has(proxy, _boundFunctions))
    queueMicrotask(() => {
      if (proxy === hydro)
        Reflect.defineProperty(proxy, _boundFunctions, {
          value: boundFunctions,
        });
    });

  return proxy as hydroObject;
}

function cleanProxy(proxy: any) {
  if (isObject(proxy) && isProxy(proxy)) {
    reactivityMap.delete(proxy);
    /* c8 ignore next 4 */
    if (bindMap.has(proxy)) {
      bindMap.get(proxy)!.forEach(removeElement);
      bindMap.delete(proxy);
    }
  }
}

function checkReactivityMap(obj: any, key: keyof any, val: any, oldVal: any) {
  const keyToNodeMap = reactivityMap.get(obj)!;
  const nodeToChangeMap = keyToNodeMap.get(String(key));

  if (nodeToChangeMap) {
    /* c8 ignore next 5 */
    if (Reflect.get(obj, Placeholder.asyncUpdate)) {
      schedule(updateDOM, nodeToChangeMap, val, oldVal);
    } else {
      updateDOM(nodeToChangeMap, val, oldVal);
    }
  }

  if (isObject(val)) {
    Object.entries(val).forEach(([subKey, subVal]) => {
      const subOldVal =
        (isObject(oldVal) && Reflect.get(oldVal, subKey)) || oldVal;
      const nodeToChangeMap = keyToNodeMap.get(subKey);
      if (nodeToChangeMap) {
        /* c8 ignore next 5 */
        if (Reflect.get(obj, Placeholder.asyncUpdate)) {
          schedule(updateDOM, nodeToChangeMap, subVal, subOldVal);
        } else {
          updateDOM(nodeToChangeMap, subVal, subOldVal);
        }
      }
    });
  }
}

function updateDOM(nodeToChangeMap: nodeToChangeMap, val: any, oldVal: any) {
  nodeToChangeMap.forEach((entry) => {
    // Circular reference in order to keep Memory low
    if (isNode(entry as Text)) {
      /* c8 ignore next 5 */
      if (!(entry as Node).isConnected) {
        const tmpChange = nodeToChangeMap.get(entry)!;
        nodeToChangeMap.delete(entry);
        nodeToChangeMap.delete(tmpChange);
      }
      return; // Continue in forEach
    }

    // For each change of the node update either attribute or textContent
    (entry as nodeChange).forEach((change) => {
      const node = nodeToChangeMap.get(entry) as Element | Text;
      const [start, end, key] = change;
      let useStartEnd = false;

      if (isNode(val)) {
        replaceElement(val as Element, node);
        runLifecyle(node, onCleanupMap);
      } else if (isTextNode(node)) {
        useStartEnd = true;
        let text = node.nodeValue!;

        node.nodeValue =
          text.substring(0, start) + String(val) + text.substring(end);
      } else {
        if (key === Placeholder.twoWay) {
          if (
            node instanceof HTMLTextAreaElement ||
            node instanceof HTMLSelectElement ||
            (node instanceof HTMLInputElement && node.type === Placeholder.text)
          ) {
            (node as HTMLInputElement).value = String(val);
          } else if (
            node instanceof HTMLInputElement &&
            (node.type === Placeholder.checkbox ||
              node.type === Placeholder.radio)
          ) {
            node.checked = Array.isArray(val)
              ? val.includes(node.name)
              : String(val) === node.value;
          }
        } else if (isFunction(val) || isEventObject(val)) {
          const eventName = key!.replace(onEventRegex, "");
          node.removeEventListener(
            eventName,
            isFunction(val) ? val : val.event
          );
          addEventListener(node, eventName, val);
        } else if (isObject(val)) {
          Object.entries(val).forEach(([subKey, subVal]) => {
            if (isFunction(subVal) || isEventObject(subVal)) {
              const eventName = subKey.replace(onEventRegex, "");
              node.removeEventListener(
                eventName,
                isFunction(subVal) ? subVal : subVal.event
              );
              addEventListener(node, eventName, subVal);
            } else {
              setAttribute(node, subKey, subVal);
            }
          });
        } else {
          useStartEnd = true;
          let attr = node.getAttribute(key!);
          if (attr) {
            attr = attr.substring(0, start) + String(val) + attr.substring(end);
            setAttribute(node, key!, attr === String(val) ? val : attr);
          } else {
            setAttribute(node, key!, val);
          }
        }
      }

      if (useStartEnd) {
        // Update end
        change[1] = start + String(val).length;

        // Because we updated the end, we also have to update the start and end for every other reactive change in the node, for the same key
        let passedNode: boolean;
        allNodeChanges.get(node)?.forEach((nodeChange) => {
          if (nodeChange === change) {
            passedNode = true;
            return;
          }

          if (passedNode && (isTextNode(node) || key === nodeChange[2])) {
            const difference = String(oldVal).length - String(val).length;
            nodeChange[0] -= difference;
            nodeChange[1] -= difference;
          }
        });
      }
    });
  });
}
function view(
  root: string,
  data: reactiveObject<Array<any>>,
  renderFunction: (value: any, index: number) => Node
) {
  viewElements = true;
  const rootElem = $(root)!;
  const elements = getValue(data).map(renderFunction);
  rootElem.append(...elements);
  elements.forEach((elem) => runLifecyle(elem as Element, onRenderMap));
  viewElements = false;
  observe(data, (newData: typeof data, oldData: typeof data) => {
    /* c8 ignore start */
    viewElements = true;

    // Reset or re-use
    if (
      !newData?.length ||
      (!reuseElements && newData?.length === oldData?.length)
    ) {
      rootElem.textContent = "";
    } else if (reuseElements) {
      for (let i = 0; i < oldData?.length && newData?.length; i++) {
        oldData[i].id = newData[i].id;
        oldData[i].label = newData[i].label;
        newData[i] = oldData[i];
      }
    }

    // Add to existing
    if (oldData?.length && newData?.length > oldData?.length) {
      const length = oldData.length;
      const slicedData = newData.slice(length);
      const newElements = slicedData.map((item, i) =>
        renderFunction(item, i + length)
      );
      rootElem.append(...newElements);
      newElements.forEach((elem) => runLifecyle(elem as Element, onRenderMap));
    }

    // Add new
    else if (oldData?.length === 0 || (!reuseElements && newData?.length)) {
      const elements = newData.map(renderFunction);
      rootElem.append(...elements);
      elements.forEach((elem) => runLifecyle(elem as Element, onRenderMap));
    }
    viewElements = false;
    /* c8 ignore end */
  });
}

const hydro = generateProxy();
const $ = document.querySelector.bind(document);
const $$ = document.querySelectorAll.bind(document);

const internals = {
  compare,
};
export {
  render,
  html,
  h,
  hydro,
  setGlobalSchedule,
  setReuseElements,
  setInsertDiffing,
  setShouldSetReactivity,
  reactive,
  unset,
  setAsyncUpdate,
  unobserve,
  observe,
  ternary,
  emit,
  watchEffect,
  internals,
  getValue,
  onRender,
  onCleanup,
  setReactivity,
  $,
  $$,
  view,
};
