export type Pos = number;

export interface AttributeNode {
  readonly kind: 'attribute';
  readonly prefix: string | null;
  readonly local: string;
  /** raw value between quotes, WITHOUT the surrounding quote character */
  readonly rawValue: string;
  readonly quote: '"' | "'";
  readonly start: Pos;
  readonly end: Pos;
  readonly nameStart: Pos;
  readonly nameEnd: Pos;
}

export interface EntityRef {
  readonly kind: 'entityRef';
  readonly name: string;
  readonly hex: boolean;
  readonly raw: string;
  readonly start: Pos;
  readonly end: Pos;
}

export interface TextNode {
  readonly kind: 'text';
  readonly value: string;
  readonly entities: ReadonlyArray<EntityRef>;
  readonly start: Pos;
  readonly end: Pos;
  id?: string;
}

export interface ElementNode {
  readonly kind: 'element';
  readonly prefix: string | null;
  readonly local: string;
  readonly attributes: AttributeNode[];
  readonly nsDecls: AttributeNode[];
  children: Node[];
  readonly start: Pos;
  readonly end: Pos;
  readonly openEnd: Pos;
  readonly selfClosing: boolean;
  readonly closeStart: Pos | null;
  readonly closeEnd: Pos | null;
  readonly nameStart: Pos;
  readonly nameEnd: Pos;
  id?: string;
}

export interface CommentNode {
  readonly kind: 'comment';
  readonly text: string;
  readonly start: Pos;
  readonly end: Pos;
  id?: string;
}

export interface PINode {
  readonly kind: 'pi';
  readonly target: string;
  readonly body: string;
  readonly start: Pos;
  readonly end: Pos;
  id?: string;
}

export interface CDataNode {
  readonly kind: 'cdata';
  readonly text: string;
  readonly start: Pos;
  readonly end: Pos;
  id?: string;
}

export interface DoctypeNode {
  readonly kind: 'doctype';
  readonly text: string;
  readonly start: Pos;
  readonly end: Pos;
  id?: string;
}

export type Node = ElementNode | TextNode | CommentNode | PINode | CDataNode | DoctypeNode;

export interface XmlDocument {
  readonly source: string;
  readonly content: Node[];
  readonly declaration: PINode | null;
  readonly doctype: DoctypeNode | null;
  readonly root: ElementNode;
}

export interface XmlParseError extends Error {
  pos: Pos;
}
