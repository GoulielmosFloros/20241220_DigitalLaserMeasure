import * as OBC from "@thatopen/components";
import * as THREE from "three";
import * as BUI from "@thatopen/ui";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";

export class LaserMeasurer extends OBC.Component {
  static uuid = "883f4c40-7e7b-4534-8907-d3c6240b10c8" as const;
  public includedClasses: Number[] | null = [
    1529196076, 3512223829, 3304561284, 395920057,
  ];

  // We use accessors for the enable property as we want to
  // have some side-effects. In this case, we want the
  // highlighter to be disabled when the measurement is enabled as its
  // very annoying to select the elements if you only want to measure
  private _enabled = false;
  get enabled() {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
    if (!value) this.hideVisuals();
    const highlighter = this.components.get(OBF.Highlighter);
    highlighter.enabled = !value;
  }

  // A world is needed because some things have to be added to its scene.
  private _world: OBC.World | null = null;

  get world() {
    return this._world;
  }

  set world(value: OBC.World | null) {
    this._world = value;
    if (!value) return;
    // We make sure, once the world is set, to add all the measurement lines
    // and marks to display the distances
    for (const mesh of this._lines) value.scene.three.add(mesh);
    // The marks can be created only when the world is known
    this._marks = [
      new OBF.Mark(value, BUI.Component.create(this._markTemplate)),
      new OBF.Mark(value, BUI.Component.create(this._markTemplate)),
      new OBF.Mark(value, BUI.Component.create(this._markTemplate)),
      new OBF.Mark(value, BUI.Component.create(this._markTemplate)),
      new OBF.Mark(value, BUI.Component.create(this._markTemplate)),
      new OBF.Mark(value, BUI.Component.create(this._markTemplate)), // one more mark here
    ];
    this.hideVisuals();
  }

  // Just a getter to directly access the world's raycaster
  private get _raycaster() {
    if (!this._world)
      throw new Error("LaserMeasurement: World has not been set!");
    const raycasters = this.components.get(OBC.Raycasters);
    return raycasters.get(this._world);
  }

  constructor(components: OBC.Components) {
    super(components);
    components.add(LaserMeasurer.uuid, this);
  }

  // The edge line and measure line are two ThreeJS instances helpers to access
  // common operations for lines.
  // The edge line allow us to set the information of the current face edge that is being
  // iterated in the measure function.
  // The measure line is used to set the information of the current measure line
  // created in the loop of the measure function.
  // Take a look at the video to know more information as is easier to grasp there.
  private _edgeLine = new THREE.Line3();
  private _measureLine = new THREE.Line3();

  // We create a single line material to use in all measurement lines
  material = new THREE.LineBasicMaterial({
    depthTest: false,
    color: "red",
  });

  // As the lines are always going to be 4, then we can hard code the creation
  // of 4 lines to display in the scene.
  private _lines = [
    new THREE.Line(new THREE.BufferGeometry(), this.material),
    new THREE.Line(new THREE.BufferGeometry(), this.material),
    new THREE.Line(new THREE.BufferGeometry(), this.material),
    new THREE.Line(new THREE.BufferGeometry(), this.material),
    new THREE.Line(new THREE.BufferGeometry(), this.material), // one more line here
  ];

  // Create an initial empty array to store all marks created.
  private _marks: OBF.Mark[] = [];

  // The recomendation is always to keep the logic and user interface separated.
  // However, we define the mark template here for simplicity purposes.
  private _markTemplate = () => BUI.html`
    <bim-label style="background-color: var(--bim-ui_bg-base); padding: 0.25rem 0.5rem; border-radius: 1rem;"></bim-label> 
  `;

  measure() {
    this.hideVisuals();
    if (!this.enabled) return;
    // When the measure method is called, a ray is cast to the mouse location
    const result = this._raycaster.castRay();
    if (!result) return;

    // From the casting result we get some important information:
    // object: tell us the element hit.
    // instanceId: as fragments are InstanceMeshes, the id tell us the instance hit.
    // faceIndex: as the fragments geometry is indexed, we can now the index of
    // the triangle that was hit.
    // extracting the face.
    // hitPoint: the hit location
    const { object, instanceId, faceIndex, face, point: hitPoint } = result;
    // Not all casting results includes all the data above, but we need it.
    // Making sure it exists is fundamental to continue with the function.
    if (
      !(
        object instanceof FRAGS.FragmentMesh &&
        instanceId !== undefined &&
        faceIndex !== undefined &&
        face
      )
    ) {
      return;
    }

    if (!this.includedClasses) return;

    const model = object.fragment.group;
    const expressID = object.fragment.getItemID(instanceId);

    if (!model || !expressID) return;

    const properties = model?.getLocalProperties();
    if (properties) {
      for (const id in properties) {
        if (Number(id) === Number(expressID)) {
          const elemProperties = properties[id];
          if (!elemProperties) return;
          if (!this.includedClasses?.includes(elemProperties.type)) return;
        }
      }
    }

    // The MeasurementUtils component includes a set of general purpose
    // utilities for fragments geometry.
    const measurements = this.components.get(OBC.MeasurementUtils);
    // In this case, using the information from the casting result
    // we can get the pair of vectors that defines each edge in the hit surface
    const faceData = measurements.getFace(object, faceIndex, instanceId);
    if (!faceData) return;
    const { edges } = faceData;

    // We may have many perpendicular edges in the same direction from the
    // hit point.
    // Using this variable we can group them.
    const pointsPerDirection: Record<string, THREE.Vector3[]> = {};

    // Using the helper function we did before, we get the plane representing the face hit.
    const facePlane = this.getFacePlane(object, instanceId, face);
    // Then, with the usage of the raycaster, we cast a ray from the hit point
    // in the normal direction of the plane (which happens to be the same normal direction
    // as the hit face)
    const normalCast = this._raycaster.castRayFromVector(
      hitPoint,
      facePlane.normal,
    );

    // Then, if the raycaster hit something, we use the normal direction and the
    // hit point to store the information in the pointsPerDirection object.
    if (normalCast) {
      const hash = `${facePlane.normal.x}${facePlane.normal.y}${facePlane.normal.z}`;
      if (!pointsPerDirection[hash]) pointsPerDirection[hash] = [];
      pointsPerDirection[hash].push(normalCast.point);
    }

    for (const edge of edges) {
      // To get some helper functions for lines, we use the edge information
      // to set the current information of the global edgeLine property in the
      // component
      const [start, end] = edge.points;
      this._edgeLine.start = start;
      this._edgeLine.end = end;

      // closestPointToPointParameter projects the hit point into the edge.
      // The result is a parameter, which is a normalized distance representing
      // how far (in percentage) is the projection point from the start of the
      // line.
      const parameter = this._edgeLine.closestPointToPointParameter(hitPoint);
      // The projection point may fall outside the edge, so we skip those projections
      // by making sure they are in the 0-1 range.
      if (parameter < 0 || parameter > 1) continue;

      // The projected point holds the coordinates of the projected point.
      // This is because the parameter is just the normalized distance, but
      // not the actual coordinates.
      // This projected point, along with the hit point, define the measure line.
      const projectedPoint = new THREE.Vector3();
      this._edgeLine.at(parameter, projectedPoint);

      // In order to group the measurement lines based on their direction,
      // the direction is calculated in the following way
      const dir = new THREE.Vector3()
        .subVectors(projectedPoint, hitPoint)
        .normalize()
        .round();

      // Then, we just create a string representation of the direction
      // to use as a key in the pointsPerDirection object
      const hash = `${dir.x}${dir.y}${dir.z}`;
      if (!pointsPerDirection[hash]) pointsPerDirection[hash] = [];
      pointsPerDirection[hash].push(projectedPoint);
    }

    // We need to iterate over all grouped projections per direction
    // to choose the closests to the hit point.
    // The closests projection will define the end point of the measure line.
    let index = 0;
    for (const [, projections] of Object.entries(pointsPerDirection)) {
      // First, we make sure there is a corresponding line element and mark
      // to display the information in the viewer.
      const line = this._lines[index];
      const mark = this._marks[index];
      if (!(line && mark)) continue;

      // Using Array.reduce, we can get the closest projection to the hit point
      const closestProjection = projections.reduce((prev, curr) => {
        const prevLength = this.distanceBetweenVectors(prev, hitPoint);
        const currLength = this.distanceBetweenVectors(curr, hitPoint);
        if (prevLength < currLength) return prev;
        return curr;
      });

      // Using the closest and hit points, we define the data in the
      // global measure line to access helpful functions.
      this._measureLine.start = hitPoint;
      this._measureLine.end = closestProjection;

      // The line geometry is set from the measure line points
      line.geometry.setFromPoints([
        this._measureLine.start,
        this._measureLine.end,
      ]);
      // Is important to tell ThreeJS the geometry position must be updated
      // to actually see the changes visually
      line.geometry.attributes.position.needsUpdate = true;
      // The bounding elements must be recomputed so frustum culling can work
      line.geometry.computeBoundingBox();
      line.geometry.computeBoundingSphere();
      line.visible = true;

      // The mark element content is set to be the distance (length) of the measure line
      mark.three.element.textContent = `${this._measureLine.distance().toFixed(2)}m`;
      // Also, the mark position will be the measure line center
      const center = new THREE.Vector3();
      this._measureLine.getCenter(center);
      mark.three.position.copy(center);
      mark.visible = true;

      index++;
    }
  }

  private distanceBetweenVectors(a: THREE.Vector3, b: THREE.Vector3) {
    const distance = new THREE.Vector3().subVectors(a, b).length();
    return distance;
  }

  // This is a helper method to hide all lines and marks when needed.
  private hideVisuals() {
    for (const line of this._lines) line.visible = false;
    for (const mark of this._marks) mark.visible = false;
  }

  // The mesh is the FragmentMesh hit
  private getFacePlane = (
    mesh: THREE.InstancedMesh,
    instanceID: number,
    face: THREE.Face,
  ) => {
    // InstancedMeshes work by using the same geometry in diferent places.
    // Each place (along with a scale and rotation) is defined by transformation matrix.
    // First, we get the transformation matrix of the instance hit.
    const instanceMatrix = new THREE.Matrix4();
    mesh.getMatrixAt(instanceID, instanceMatrix);
    // Then, using the geometry position array and the face, we get
    // each vertex that conforms the hit face
    const positionAtt = mesh.geometry.attributes.position;
    const V1 = new THREE.Vector3()
      .fromBufferAttribute(positionAtt, face.a)
      .applyMatrix4(instanceMatrix);
    const V2 = new THREE.Vector3()
      .fromBufferAttribute(positionAtt, face.b)
      .applyMatrix4(instanceMatrix);
    const V3 = new THREE.Vector3()
      .fromBufferAttribute(positionAtt, face.c)
      .applyMatrix4(instanceMatrix);
    // Lastly, a plane representing the hit face is created.
    const plane = new THREE.Plane();
    plane.setFromCoplanarPoints(V1, V2, V3);
    return plane;
  };
}
