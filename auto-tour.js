import { NAVIGATION } from './navigation.js?v=20261015-delivery2';

// Camera routes stay on the verified logistics aisle or the independent visitor ring.
// Each selected space repeats a slow out-and-back dolly, with a pause at both ends.
export const AUTO_TOUR_SPEED = 1.2;
const groundViewY = NAVIGATION.groundY + NAVIGATION.groundEyeHeight;
export const AUTO_ROUTES = {
  aerial: { duration: 52, hold: 4, aerial: true },
  entrance: { duration: 42, hold: 4, points: [[0,groundViewY,8],[0,groundViewY,-15],[0,groundViewY,-41]], targets: [[0,2.3,-50],[5,2.5,-55],[-5,2.4,-82]] },
  production: { duration: 58, hold: 4, points: [[0,groundViewY,-57],[0,groundViewY,-88],[0,groundViewY,-122]], targets: [[2,2.6,-111],[9,2.4,-118],[0,2.8,-145]] },
  gallery: { duration: 29, hold: 4, points: [[-45.1,6.7,-8],[-45.1,6.7,-18],[-45.1,6.7,-25.6]], targets: [[-45.1,6.7,-37],[-39,5.5,-35],[-22,1.1,-45]] },
  corner: { duration: 34, hold: 5, points: [[-45.1,6.7,-25.6],[-45.1,6.7,-36],[-45.1,6.7,-47]], targets: [[-22,1.1,-45],[-24,1.4,-47],[-23,1.2,-54]] },
  longside: { duration: 47, hold: 5, points: [[-45.1,6.7,-65],[-45.1,6.7,-82],[-45.1,6.7,-99]], targets: [[-27,1,-68],[-25,1.2,-86],[-19,1.4,-111]] },
  farend: { duration: 42, hold: 5, points: [[0,6.7,-134.2],[19,6.7,-134.2],[36,6.7,-134.2]], targets: [[0,1.3,-105],[8,1.3,-99],[19,1.3,-104]] },
};

const lerp3=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));

export function sampleAutoRoute(id, seconds) {
  const r=AUTO_ROUTES[id];
  if(!r)throw new Error(`Unknown camera route: ${id}`);
  const cycle=2*(r.duration+r.hold), time=((seconds%cycle)+cycle)%cycle;
  const returning=time>=r.duration+r.hold;
  const travelling=returning?time-r.duration-r.hold:time;
  const linear=Math.min(travelling/r.duration,1);
  // Smooth acceleration at both ends; no cut or teleport when the dolly returns.
  const eased=.5-.5*Math.cos(Math.PI*linear), progress=returning?1-eased:eased;
  let position,target;
  if(r.aerial){
    const radius=Math.hypot(-159,163), angle=Math.atan2(-159,163)-progress*.82;
    position=[Math.sin(angle)*radius,123-8*Math.sin(progress*Math.PI),-88+Math.cos(angle)*radius];
    target=[0,3,-88];
  }else{
    const lengths=r.points.slice(1).map((p,i)=>distance(p,r.points[i]));
    const total=lengths.reduce((a,b)=>a+b,0);let d=progress*total,index=0;
    while(index<lengths.length-1&&d>lengths[index])d-=lengths[index++];
    const t=lengths[index]?Math.min(d/lengths[index],1):0;
    position=lerp3(r.points[index],r.points[index+1],t);
    target=lerp3(r.targets[index],r.targets[index+1],t);
  }
  return {position,target,progress,returning,holding:travelling>=r.duration,cycle};
}

export function auditAutoRoutes(stages,isPositionBlocked) {
  const failures=[];let samples=0;
  for(const stage of stages){
    const route=AUTO_ROUTES[stage.id];
    if(stage.floor==='aerial')continue;
    for(let t=0;t<=route.duration;t+=.1){
      const p=sampleAutoRoute(stage.id,t).position;samples++;
      if(isPositionBlocked(p[0],p[2],stage.floor)){failures.push({stage:stage.id,time:Number(t.toFixed(1)),position:p});break;}
    }
  }
  return {samples,failures,passed:failures.length===0};
}
